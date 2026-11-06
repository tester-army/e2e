/**
 * The part of an attempt's network that lives as long as one user context:
 * the subscription, collectors, and intercepts installed for it, its tabs,
 * and one record per request it has in flight, decided, or still loading a
 * body. A reset or restore replaces the user context, and with it the whole
 * binding, so nothing of the old context's requests reaches the new one.
 */

import type { Network } from 'webdriver-bidi-protocol';
import { raceAbort } from 'e2e/engine';
import { BidiError, type BidiConnection, type BidiEventParams } from './connection.ts';
import type { ContextTree } from './context-tree.ts';
import { releaseQuietly } from './errors.ts';

/** A finished response as a response wait reports it. */
export interface ObservedResponse {
  readonly url: string;
  readonly status: number;
  /** Header names lowercased; cookie headers are left out, as Playwright's `response.headers()` does. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body once it finished loading, read once; rejects when the load failed or the browser kept none (a redirect, an evicted body). */
  body(): Promise<Buffer>;
}

/** What the attempt wants of the network, whatever the user context it is bound to. */
export interface NetworkWants {
  /** Whether every request is held whether or not a route is set: site headers to add. */
  readonly holdAll: boolean;
  /** How many routes are registered. */
  readonly routes: number;
  /** Whether requests in flight are counted, for a `networkidle` wait. */
  readonly tracking: boolean;
  /** Whether basic-auth challenges are answered. */
  readonly credentials: boolean;
}

/** What a binding installs, derived from the attempt's wants and the binding's blank-served tabs (`interceptionPolicy`). */
interface InterceptionPolicy {
  /** Whether the request events are needed: held requests, credentials, or an idle count. */
  readonly events: boolean;
  /** Whether request bodies are collected, for routes to read. */
  readonly requestBodies: boolean;
  /** Whether every request of the attempt's tabs is held. */
  readonly hold: boolean;
  /** Whether basic-auth challenges are held. */
  readonly auth: boolean;
}

/** How a redirect hop of a request goes on: the route's header overrides, the method it was continued with, and the site headers the driver added to the previous hop. */
export interface RedirectPolicy {
  readonly overrides?: Readonly<Record<string, string>>;
  readonly method: string;
  readonly injected?: Readonly<Record<string, string>>;
}

/** Everything the binding keeps of one request, from its first event until its last hop settles, its tab closes, or every wait that matched it read its body. */
interface RequestRecord {
  /** The browsing context it came from, whose closing retires it. */
  context: string;
  /** Whether it counts as in flight for `networkidle`: a request of the attempt's tab that is no EventSource stream, between a hop's start and its settling. */
  counted: boolean;
  /** Whether its last hop settled. */
  settled: boolean;
  redirect?: RedirectPolicy;
  /** The body a route fulfilled it with, which a response wait reads since the browser keeps none. */
  fulfilledBody?: Buffer;
  /** Whether its basic-auth challenge was answered once. */
  authAnswered?: boolean;
  /** Response waits that matched it and have not finished reading its body. */
  waits: number;
  /** Its response body as the collector kept it, read once for every wait that matched it. */
  body?: Promise<Buffer>;
}

/** An intercept in place, and the tabs it covers (none on a browser of its own). */
interface InstalledIntercept {
  readonly id: string;
  readonly covers: string;
}

type InterceptPhase = 'beforeRequestSent' | 'authRequired';

/** How a binding is set up, constant for its life. */
export interface NetworkBindingOptions {
  /** Whether no other client drives the browser, so one intercept covers every tab from its first request. */
  readonly exclusive: boolean;
  /** The browsing-context tree, which tells a tab that closed from one still open. */
  readonly contexts: ContextTree;
  /** Whether an event belongs to the attempt. */
  readonly ours: (event: { readonly context: string | null }) => boolean;
  /** Starts the request event listeners for this binding; returns their removals. */
  readonly listen: (binding: NetworkBinding) => (() => void)[];
}

/** The window of no requests in flight Playwright's `networkidle` waits for. */
const NETWORK_IDLE_MS = 500;
/** The largest body a collector keeps, per request or response. */
const MAX_COLLECTED_BODY = 20 * 1024 * 1024;

/** The one rule of what a binding installs: requests are held for site headers, routes, or a blank-served tab; the events are needed for those, an idle count, or credentials. */
function interceptionPolicy(wants: NetworkWants, blankTabs: number): InterceptionPolicy {
  const hold = wants.holdAll || wants.routes > 0 || blankTabs > 0;
  return { events: hold || wants.tracking || wants.credentials, requestBodies: wants.routes > 0, hold, auth: wants.credentials };
}

/** One user context's network state and the browser resources installed for it. */
export class NetworkBinding {
  /** The context's top-level tabs; intercepts cover exactly the ones still open, so a browser shared with other sessions keeps its own requests. */
  private readonly tops = new Set<string>();
  /** Top-level tabs whose every document request is answered with a blank page (`serveBlank`), before any route. */
  private readonly blank = new Set<string>();
  /** Every intercept added for the context, so a request a replaced one still holds is decided. */
  private readonly intercepts = new Set<string>();
  private readonly requests = new Map<string, RequestRecord>();
  private lastSettled = Date.now();
  private readonly installed = new Map<InterceptPhase, InstalledIntercept>();
  private subscription: string | undefined;
  private requestCollector: string | undefined;
  private collector: Promise<string> | undefined;
  private listeners: (() => void)[] = [];
  private readonly offSettle: (() => void)[];
  /** Settles each response wait still pending, with the failure that ended it. */
  private readonly waits = new Set<(failure: Error | null) => void>();
  private closed = false;

  constructor(
    private readonly connection: BidiConnection,
    readonly userContext: string,
    private readonly options: NetworkBindingOptions,
  ) {
    this.offSettle = [
      connection.on('network.responseCompleted', (event) => this.settle(event)),
      connection.on('network.fetchError', (event) => this.settle(event)),
    ];
  }

  /**
   * Brings what is installed in line with what `wants` and the blank-served
   * tabs need (`interceptionPolicy`): the subscription and its listeners,
   * the request and response collectors, and the intercepts, each checked on
   * its own, so a step that failed before is installed by the next call, one
   * already in place is kept, and an intercept or request collector nothing
   * needs any more is removed.
   */
  async reconcile(wants: NetworkWants): Promise<void> {
    if (this.closed) return;
    const policy = interceptionPolicy(wants, this.blank.size);
    if (policy.events) {
      if (this.listeners.length === 0) this.listeners = this.options.listen(this);
      this.subscription ??= (await this.connection.send('session.subscribe', {
        events: ['network.beforeRequestSent', 'network.authRequired'],
        userContexts: [this.userContext],
      })).subscription;
    }
    if (policy.requestBodies) {
      this.requestCollector ??= (await this.connection.send('network.addDataCollector', {
        dataTypes: ['request'],
        maxEncodedDataSize: MAX_COLLECTED_BODY,
        userContexts: [this.userContext],
      })).collector;
    } else if (this.requestCollector !== undefined) {
      await alreadyGone(this.connection.send('network.removeDataCollector', { collector: this.requestCollector }), this.connection);
      this.requestCollector = undefined;
    }
    await this.collectResponses();
    await this.ensureIntercept('beforeRequestSent', policy.hold);
    await this.ensureIntercept('authRequired', policy.auth);
  }

  /** Covers top-level tab `tab` with the intercepts from the next `reconcile`; false for a tab that already closed. */
  cover(tab: string): boolean {
    if (this.options.contexts.owner(tab) === undefined) return false;
    this.tops.add(tab);
    return true;
  }

  /** Stops covering `tab`; false when it was not covered. */
  uncover(tab: string): boolean {
    return this.tops.delete(tab);
  }

  /** Answers every document request of `tab` with a blank page from the next `reconcile`, and covers it. */
  serveBlank(tab: string): void {
    this.blank.add(tab);
    this.tops.add(tab);
  }

  /** Lets `tab`'s requests go to the routes and the network again from the next `reconcile`. */
  unserveBlank(tab: string): void {
    this.blank.delete(tab);
  }

  /** Whether `context`'s document requests are answered with a blank page. */
  isBlank(context: string): boolean {
    return this.blank.has(context);
  }

  /** Whether one of the binding's intercepts holds the request `event` reports. */
  holds(event: { readonly isBlocked: boolean; readonly intercepts?: readonly string[] }): boolean {
    return event.isBlocked && (event.intercepts ?? []).some((intercept) => this.intercepts.has(intercept));
  }

  /**
   * Keeps one intercept of `phase` in place while `wanted`. On a browser no
   * other client drives it covers every tab, so a tab the app opens is held
   * from its first request; otherwise it covers the open tabs exactly, so
   * other clients keep their own requests, and a change of tabs replaces it,
   * the new one in place before the old goes.
   */
  private async ensureIntercept(phase: InterceptPhase, wanted: boolean): Promise<void> {
    const connection = this.connection;
    const old = this.installed.get(phase);
    if (this.options.exclusive) {
      if (wanted && old === undefined) this.installed.set(phase, (await this.addIntercept(phase, undefined))!);
      if (!wanted && old !== undefined) {
        this.installed.delete(phase);
        await alreadyGone(connection.send('network.removeIntercept', { intercept: old.id }), connection);
      }
      return;
    }
    const open = (): string[] => [...this.tops].filter((context) => this.options.contexts.owner(context) !== undefined);
    const target = wanted ? open() : [];
    if (target.length === 0 ? old === undefined : old?.covers === target.join('\n')) return;
    const added = target.length === 0 ? undefined : await this.addIntercept(phase, open);
    if (added === undefined) this.installed.delete(phase);
    else this.installed.set(phase, added);
    if (old !== undefined) await alreadyGone(connection.send('network.removeIntercept', { intercept: old.id }), connection);
  }

  /**
   * Adds an intercept of `phase` for the tabs `open` lists (every tab
   * without it), trying again while tabs close under it; undefined once
   * every tab it was for closed.
   */
  private async addIntercept(phase: InterceptPhase, open: (() => string[]) | undefined): Promise<InstalledIntercept | undefined> {
    for (;;) {
      const contexts = open?.() ?? [];
      if (open !== undefined && contexts.length === 0) return undefined;
      try {
        const { intercept } = await this.connection.send('network.addIntercept', {
          phases: [phase],
          ...(open === undefined ? {} : { contexts: contexts as [string, ...string[]] }),
        });
        this.intercepts.add(intercept);
        return { id: intercept, covers: contexts.join('\n') };
      } catch (cause) {
        if (open === undefined || open().length === contexts.length) throw cause;
      }
    }
  }

  /** The context's response collector, added once however many waits ask at the same time. */
  private collectResponses(): Promise<string> {
    this.collector ??= this.connection.send('network.addDataCollector', {
      dataTypes: ['response'],
      maxEncodedDataSize: MAX_COLLECTED_BODY,
      userContexts: [this.userContext],
    }).then(({ collector }) => collector);
    const pending = this.collector;
    pending.catch(() => {
      if (this.collector === pending) this.collector = undefined;
    });
    return pending;
  }

  /** The record of `request`, made on first sight, from `context`. */
  private record(request: string, context: string): RequestRecord {
    let record = this.requests.get(request);
    if (record === undefined) this.requests.set(request, (record = { context, counted: false, settled: false, waits: 0 }));
    return record;
  }

  /** A hop of the attempt's request `request` from `context` started; it counts as in flight when `counted`. */
  started(request: string, context: string, counted: boolean): void {
    if (this.closed) return;
    const record = this.record(request, context);
    record.context = context;
    record.settled = false;
    record.counted = counted;
  }

  /** The redirect policy of `request`, kept for its next hop. */
  redirectPolicy(request: string): RedirectPolicy | undefined {
    return this.requests.get(request)?.redirect;
  }

  /** Keeps how `request`'s redirect hops go on, until its last hop settles. */
  keepRedirectPolicy(request: string, policy: RedirectPolicy): void {
    const record = this.requests.get(request);
    if (record !== undefined) record.redirect = policy;
  }

  /** Keeps the body a route fulfilled `request` with, for a response wait to read. */
  fulfilled(request: string, body: Buffer): void {
    const record = this.requests.get(request);
    if (record !== undefined) record.fulfilledBody = body;
  }

  /** Marks `request`'s basic-auth challenge answered; whether it already was, which means the credentials were refused. */
  answerAuth(request: string, context: string): boolean {
    const record = this.record(request, context);
    const answered = record.authAnswered === true;
    record.authAnswered = true;
    return answered;
  }

  /** The body the request collector kept for `request`; undefined when there is no collector or it kept none (too large, a stream). */
  async requestBody(request: string): Promise<Buffer | undefined> {
    const collector = this.requestCollector;
    if (collector === undefined) return undefined;
    try {
      return bytesOf((await this.connection.send('network.getData', { dataType: 'request', request, collector })).bytes);
    } catch (cause) {
      if (cause instanceof BidiError && cause.error === 'no such network data') return undefined;
      throw cause;
    }
  }

  /**
   * A request's hop finished. A redirect hop stops counting and its record
   * stays for the next hop; a last hop's record goes, unless a response wait
   * still reads its body. The collectors let go of the bodies no one reads:
   * the request body routes read while it was held, and a response body no
   * wait matched.
   */
  private settle(event: { readonly context: string | null; readonly request: Network.RequestData; readonly response?: Network.ResponseData }): void {
    const id = event.request.request;
    const record = this.requests.get(id);
    if (record !== undefined) this.stopCounting(record);
    const status = event.response?.status ?? 0;
    if (status >= 300 && status < 400) return;
    const read = record !== undefined && record.waits > 0;
    if (record !== undefined) record.settled = true;
    if (!read) this.requests.delete(id);
    if (this.closed || !this.options.ours(event)) return;
    const requestCollector = this.requestCollector;
    if (requestCollector !== undefined && hasBody(event.request)) {
      void releaseQuietly(this.connection.send('network.disownData', { dataType: 'request', collector: requestCollector, request: id }));
    }
    if (read || record?.fulfilledBody !== undefined) return;
    void releaseQuietly(this.collector?.then((collector) => this.connection.send('network.disownData', { dataType: 'response', collector, request: id })));
  }

  /** Retires the requests from any of `contexts`, which closed, whatever events their teardown still sends. */
  retire(contexts: ReadonlySet<string>): void {
    for (const [request, record] of this.requests) {
      if (!contexts.has(record.context)) continue;
      this.stopCounting(record);
      this.requests.delete(request);
    }
  }

  /** Drops one request from the in-flight count. */
  private stopCounting(record: RequestRecord): void {
    if (!record.counted) return;
    record.counted = false;
    if (![...this.requests.values()].some((one) => one.counted)) this.lastSettled = Date.now();
  }

  /** How long until the context has had no request in flight for 500 ms, Playwright's `networkidle`; undefined while one is. */
  untilIdle(): number | undefined {
    for (const record of this.requests.values()) if (record.counted) return undefined;
    return NETWORK_IDLE_MS - (Date.now() - this.lastSettled);
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive (`network.responseStarted`, in the
   * session's subscription); start the wait before the action that triggers
   * the response. Its body comes from the response collector, and reading it
   * waits for the load to finish, then takes the body from the collector so
   * the browser keeps it no longer. Loads that finish are tracked from the
   * call on too, so one that completes in the same burst as its headers is
   * never missed. The wait settles once, when the load ends or the binding
   * does.
   */
  async waitForResponse(matches: (url: string) => boolean, onPage: (context: string | null) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const connection = this.connection;
    if (this.closed) throw new Error('waitForResponse: the network ended');
    const wanted = (event: { readonly context: string | null; readonly request: Network.RequestData }): boolean =>
      onPage(event.context) && matches(stripHash(event.request.url));
    const finished = new Map<string, string | null>();
    let matched: string | undefined;
    let started: (event: BidiEventParams<'network.responseStarted'>) => void = () => undefined;
    let notStarted: (failure: Error) => void = () => undefined;
    const first = new Promise<BidiEventParams<'network.responseStarted'>>((resolve, reject) => {
      started = resolve;
      notStarted = reject;
    });
    let loadedOk: () => void = () => undefined;
    let loadFailed: (failure: Error) => void = () => undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      loadedOk = resolve;
      loadFailed = reject;
    });
    first.catch(() => undefined);
    loaded.catch(() => undefined);
    const offs: (() => void)[] = [];
    const finish = (failure: Error | null): void => {
      if (!this.waits.delete(finish)) return;
      for (const off of offs.splice(0)) off();
      if (failure === null) {
        loadedOk();
      } else {
        notStarted(failure);
        loadFailed(failure);
      }
    };
    const ended = (event: { readonly context: string | null; readonly request: Network.RequestData }, failure: string | null): void => {
      if (matched === undefined ? !wanted(event) : event.request.request !== matched) return;
      finished.set(event.request.request, failure);
      if (matched !== undefined) finish(failure === null ? null : new Error(failure));
    };
    this.waits.add(finish);
    offs.push(
      connection.on('network.responseCompleted', (event) => ended(event, null)),
      connection.on('network.fetchError', (event) => ended(event, event.errorText)),
    );
    let claimed: RequestRecord | undefined;
    const offStart = connection.on('network.responseStarted', (event) => {
      if (claimed !== undefined || this.closed || !onPage(event.context) || !matches(stripHash(event.response.url))) return;
      claimed = this.record(event.request.request, event.context ?? '');
      claimed.waits += 1;
      started(event);
    });
    try {
      const collector = await this.collectResponses();
      const event = await raceAbort(first, signal, 'waitForResponse');
      const request = event.request.request;
      matched = request;
      if (finished.has(request)) {
        const failure = finished.get(request);
        finish(failure == null ? null : new Error(failure));
      }
      const record = claimed!;
      let read: Promise<Buffer> | undefined;
      const readOnce = async (): Promise<Buffer> => {
        try {
          if (isRedirect(event.response)) throw new Error('Response body is unavailable for redirect responses');
          await loaded;
          if (record.fulfilledBody !== undefined) return record.fulfilledBody;
          record.body ??= connection.send('network.getData', { dataType: 'response', request, collector, disown: true }).then((data) => bytesOf(data.bytes));
          return await record.body;
        } finally {
          record.waits -= 1;
          if (record.waits === 0 && record.settled && this.requests.get(request) === record) this.requests.delete(request);
        }
      };
      return {
        url: stripHash(event.response.url),
        status: event.response.status,
        headers: withoutCookies(headerRecord(event.response.headers)),
        body: () => (read ??= readOnce()),
      };
    } catch (cause) {
      if (claimed !== undefined) claimed.waits -= 1;
      finish(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    } finally {
      offStart();
    }
  }

  /** Ends every response wait still pending with `failure`, as when the connection closes. */
  endWaits(failure: Error): void {
    for (const finish of this.waits) finish(failure);
  }

  /**
   * Ends the binding at once: its listeners stop, so no later event of the
   * old context reaches anything, its requests stop counting, and its
   * pending response waits fail. Its browser resources stay for `release`.
   */
  close(): void {
    this.closed = true;
    for (const off of [...this.listeners.splice(0), ...this.offSettle]) off();
    this.endWaits(new Error('the network ended before the response finished loading'));
    this.requests.clear();
  }

  /** The removals of everything installed for the context: every intercept ever added, the collectors, and the subscription. */
  removals(): (() => Promise<unknown>)[] {
    const connection = this.connection;
    const collector = this.collector;
    const requestCollector = this.requestCollector;
    const subscription = this.subscription;
    const removals: (() => Promise<unknown>)[] = [
      ...[...this.intercepts].map((intercept) => () => connection.send('network.removeIntercept', { intercept })),
      ...(collector === undefined ? [] : [() => collector.then((id) => connection.send('network.removeDataCollector', { collector: id }))]),
      ...(requestCollector === undefined ? [] : [() => connection.send('network.removeDataCollector', { collector: requestCollector })]),
      ...(subscription === undefined ? [] : [() => connection.send('session.unsubscribe', { subscriptions: [subscription] })]),
    ];
    this.collector = this.requestCollector = this.subscription = undefined;
    this.intercepts.clear();
    this.installed.clear();
    return removals;
  }
}

/** Whether `request` carries a body a collector may have kept. */
function hasBody(request: Network.RequestData): boolean {
  return request.bodySize !== 0 && !(request.bodySize === null && ['GET', 'HEAD'].includes(request.method));
}

/** A collector's bytes as a buffer. */
function bytesOf(bytes: Network.BytesValue): Buffer {
  return bytes.type === 'string' ? Buffer.from(bytes.value) : Buffer.from(bytes.value, 'base64');
}

/** BiDi headers as a record, names lowercased; a repeated name keeps its values joined, as Playwright reports them. */
export function headerRecord(headers: readonly Network.Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = bytesText(header.value);
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

/** `headers` without the cookie headers, which a response wait leaves out as Playwright's `response.headers()` does. */
function withoutCookies(headers: Record<string, string>): Record<string, string> {
  const { 'set-cookie': _setCookie, cookie: _cookie, ...rest } = headers;
  return rest;
}

/** The statuses Chromium follows as a redirect when the response names a `Location`. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Whether the browser followed `response` as a redirect, so it keeps no body for it: a redirect status with a `Location` header, Chromium's own rule. */
function isRedirect(response: Network.ResponseData): boolean {
  return REDIRECT_STATUSES.has(response.status) && response.headers.some((header) => header.name.toLowerCase() === 'location');
}

/** A BiDi bytes value as text. */
export function bytesText(value: Network.BytesValue): string {
  return value.type === 'string' ? value.value : Buffer.from(value.value, 'base64').toString();
}

/** A URL without its fragment, which no request carries to the server and Playwright never reports. */
export function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Errors that mean what a removal removes is already gone: the browser dropped it, or the browser itself is gone. */
const GONE = new Set(['no such intercept', 'no such network collector', 'no such network data', 'invalid argument']);

/** Waits for a removal, taking a resource the browser no longer has (or a browser that is gone) as removed. */
export async function alreadyGone(removal: Promise<unknown> | undefined, connection: BidiConnection): Promise<void> {
  try {
    await removal;
  } catch (cause) {
    if (connection.isClosed || (cause instanceof BidiError && GONE.has(cause.error))) return;
    throw cause;
  }
}
