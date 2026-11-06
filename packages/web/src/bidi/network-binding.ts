/**
 * The part of an attempt's network that lives as long as one user context:
 * the subscription, collectors, and intercepts installed for it, its tabs,
 * and the requests it has in flight, decided, or still loading a body. A
 * reset or restore replaces the user context, and with it the whole binding,
 * so nothing of the old context's requests reaches the new one.
 */

import type { Network } from 'webdriver-bidi-protocol';
import { raceAbort } from 'e2e/engine';
import { BidiError, type BidiConnection, type BidiEventParams } from './connection.ts';

/** A finished response as a response wait reports it. */
export interface ObservedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The body once it finished loading; rejects when the load failed or the browser kept none (a redirect, an evicted body). */
  body(): Promise<Buffer>;
}

/** What a binding installs: the attempt's wants, checked against what is already in place on every change. */
export interface InterceptionPolicy {
  /** Whether the request events are needed: held requests, credentials, or an idle count. */
  readonly events: boolean;
  /** Whether request bodies are collected, for routes to read. */
  readonly requestBodies: boolean;
  /** Whether every request of the attempt's tabs is held. */
  readonly hold: boolean;
  /** Whether basic-auth challenges are held. */
  readonly auth: boolean;
  /** Whether one intercept covers every tab, on a browser no other client drives. */
  readonly exclusive: boolean;
}

/** How a redirect hop of a request goes on: the route's header overrides, the method it was continued with, and the site headers the driver added to the previous hop. */
interface RedirectPolicy {
  readonly overrides?: Readonly<Record<string, string>>;
  readonly method: string;
  readonly injected?: Readonly<Record<string, string>>;
}

/** An intercept in place, and the tabs it covers (none on a browser of its own). */
interface InstalledIntercept {
  readonly id: string;
  readonly covers: string;
}

type InterceptPhase = 'beforeRequestSent' | 'authRequired';

/** The window of no requests in flight Playwright's `networkidle` waits for. */
const NETWORK_IDLE_MS = 500;
/** The largest body a collector keeps, per request or response. */
const MAX_COLLECTED_BODY = 20 * 1024 * 1024;

/** One user context's network state and the browser resources installed for it. */
export class NetworkBinding {
  /** The context's top-level tabs; intercepts cover exactly these, so a browser shared with other sessions keeps its own requests. */
  readonly tops = new Set<string>();
  /** Tabs that closed, as their events said, before the queue caught up. */
  readonly closedTabs = new Set<string>();
  /** Top-level tabs whose every document request is answered with a blank page (`serveBlank`), before any route. */
  readonly blank = new Set<string>();
  /** Every intercept added for the context, so a request a replaced one still holds is decided. */
  readonly intercepts = new Set<string>();
  /** How each continued request's redirect hops go on, until its last hop settles. */
  readonly redirects = new Map<string, RedirectPolicy>();
  /** Bodies routes fulfilled, which a response wait reads since the browser keeps none of them. */
  readonly fulfilledBodies = new Map<string, Buffer>();
  /** Requests whose basic-auth challenge was answered once. */
  readonly answered = new Set<string>();
  requestCollector: string | undefined;
  /** The context's requests in flight, by request id, with the browsing context each came from. */
  private readonly inflight = new Map<string, string>();
  private lastSettled = Date.now();
  private readonly installed = new Map<InterceptPhase, InstalledIntercept>();
  private subscription: string | undefined;
  private collector: Promise<string> | undefined;
  private listeners: (() => void)[] = [];
  /** Settles each response wait still pending, with the failure that ended it. */
  private readonly waits = new Set<(failure: Error | null) => void>();
  private closed = false;

  /**
   * @param listen Starts the request event listeners for this binding; returns their removals.
   */
  constructor(
    private readonly connection: BidiConnection,
    readonly userContext: string,
    private readonly listen: (binding: NetworkBinding) => (() => void)[],
  ) {}

  /**
   * Brings what is installed in line with `policy`: the subscription and its
   * listeners, the request and response collectors, and the intercepts, each
   * checked on its own, so a step that failed before is installed by the
   * next call and one already in place is kept.
   */
  async reconcile(policy: InterceptionPolicy): Promise<void> {
    if (this.closed) return;
    if (policy.events) {
      if (this.listeners.length === 0) this.listeners = this.listen(this);
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
    }
    await this.collectResponses();
    await this.ensureIntercept('beforeRequestSent', policy.hold || this.blank.size > 0, policy.exclusive);
    await this.ensureIntercept('authRequired', policy.auth, policy.exclusive);
  }

  /**
   * Keeps one intercept of `phase` in place while `wanted`. On a browser no
   * other client drives it covers every tab, so a tab the app opens is held
   * from its first request; otherwise it covers the live tabs exactly, so
   * other clients keep their own requests, and a change of tabs replaces it,
   * the new one in place before the old goes. A tab that closes while its
   * intercept is being added is left out and the intercept added again.
   */
  private async ensureIntercept(phase: InterceptPhase, wanted: boolean, exclusive: boolean): Promise<void> {
    const connection = this.connection;
    const old = this.installed.get(phase);
    if (exclusive) {
      if (wanted && old === undefined) this.installed.set(phase, await this.addIntercept(phase, undefined));
      return;
    }
    const live = (): string[] => [...this.tops].filter((context) => !this.closedTabs.has(context));
    const target = wanted ? live() : [];
    if (target.length === 0 ? old === undefined : old?.covers === target.join('\n')) return;
    if (target.length === 0) this.installed.delete(phase);
    else this.installed.set(phase, await this.addIntercept(phase, live));
    if (old !== undefined) await alreadyGone(connection.send('network.removeIntercept', { intercept: old.id }), connection);
  }

  /** Adds an intercept of `phase` for the tabs `live` lists (every tab without it), trying again while tabs close under it. */
  private async addIntercept(phase: InterceptPhase, live: (() => string[]) | undefined): Promise<InstalledIntercept> {
    for (;;) {
      const contexts = live?.() ?? [];
      try {
        const { intercept } = await this.connection.send('network.addIntercept', {
          phases: [phase],
          ...(live === undefined ? {} : { contexts: contexts as [string, ...string[]] }),
        });
        this.intercepts.add(intercept);
        return { id: intercept, covers: contexts.join('\n') };
      } catch (cause) {
        if (live === undefined || live().length === contexts.length) throw cause;
      }
    }
  }

  /** The context's response collector, added once however many waits ask at the same time. */
  collectResponses(): Promise<string> {
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

  /** Counts a request of the attempt's tab as in flight. */
  started(request: string, context: string): void {
    if (!this.closed) this.inflight.set(request, context);
  }

  /** A request finished: its redirect policy ends with its last hop, and once none is in flight, the idle window starts. */
  settle(event: { readonly request: Network.RequestData; readonly response?: Network.ResponseData }): void {
    const status = event.response?.status ?? 0;
    if (status < 300 || status >= 400) this.redirects.delete(event.request.request);
    this.forget(event.request.request);
  }

  /** Retires the requests in flight from `context`, a tab that closed, whatever events its teardown still sends. */
  retire(context: string): void {
    for (const [request, from] of this.inflight) if (from === context) this.forget(request);
  }

  /** Drops one request from the in-flight count. */
  private forget(request: string): void {
    if (!this.inflight.delete(request)) return;
    if (this.inflight.size === 0) this.lastSettled = Date.now();
  }

  /** How long until the context has had no request in flight for 500 ms, Playwright's `networkidle`; undefined while one is. */
  untilIdle(): number | undefined {
    return this.inflight.size > 0 ? undefined : NETWORK_IDLE_MS - (Date.now() - this.lastSettled);
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive (`network.responseStarted`, in the
   * session's subscription); start the wait before the action that triggers
   * the response. Its body comes from the response collector, and reading it
   * waits for the load to finish. Loads that finish are tracked from the
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
    const offStart = connection.on('network.responseStarted', (event) => {
      if (onPage(event.context) && matches(stripHash(event.response.url))) started(event);
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
      return {
        url: stripHash(event.response.url),
        status: event.response.status,
        headers: headerRecord(event.response.headers),
        body: async () => {
          if (isRedirect(event.response)) throw new Error('Response body is unavailable for redirect responses');
          await loaded;
          const fulfilled = this.fulfilledBodies.get(request);
          if (fulfilled !== undefined) return fulfilled;
          const data = await connection.send('network.getData', { dataType: 'response', request, collector });
          return data.bytes.type === 'string' ? Buffer.from(data.bytes.value) : Buffer.from(data.bytes.value, 'base64');
        },
      };
    } catch (cause) {
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
    for (const off of this.listeners.splice(0)) off();
    this.endWaits(new Error('the network ended before the response finished loading'));
    this.inflight.clear();
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
