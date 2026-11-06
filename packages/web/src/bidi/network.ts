/**
 * One attempt's network on the BiDi driver: request interception for the
 * test's routes and the configured site headers (`network.addIntercept` and
 * its continue, provide, and fail commands), basic-auth answers
 * (`authRequired` and `continueWithAuth`), the in-flight request count a
 * `networkidle` wait reads, and response waits whose bodies come from a data
 * collector. Interception and the extra subscriptions start only when
 * something needs them, since each blocked request costs a protocol round
 * trip.
 */

import { readFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import path from 'node:path';
import type { Network } from 'webdriver-bidi-protocol';
import { raceAbort } from 'e2e/engine';
import { BidiError, type BidiConnection, type BidiEventParams } from './connection.ts';
import { lowercaseNames } from '../protected-app.ts';
import { releaseQuietly } from './errors.ts';

/** A request the browser holds for a route to decide. */
export interface InterceptedRequest {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  /** Header names lowercased, as Playwright reports a request's headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, when it has one the browser collected. */
  readonly postData?: string;
  /** The same body as the browser sent it, byte for byte. */
  readonly body?: Buffer;
  /** Whether the request had a body the browser kept none of (too large, a stream), so it cannot be replayed. */
  readonly bodyUnavailable?: boolean;
  /** The cookies the browser sends with it, as one `cookie` header value. */
  readonly cookie?: string;
}

/** What a route does with one held request; exactly one of these runs. */
export interface RouteDecisions {
  continue(overrides?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }): Promise<void>;
  fulfill(response: { status: number; headers: Record<string, string>; contentType?: string; body?: string | Uint8Array; json?: unknown; path?: string }): Promise<void>;
  abort(): Promise<void>;
  /** Hands the request to the next older matching route, or to the network. */
  fallback(): Promise<void>;
}

/** One registered route: which URLs it takes, and what it does with each request. */
export interface NetworkRoute {
  readonly predicate: (url: URL) => boolean;
  readonly handle: (request: InterceptedRequest, decisions: RouteDecisions) => Promise<void>;
}

/** A finished response as a response wait reports it. */
export interface ObservedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The body once it finished loading; rejects when the load failed or the browser kept none (a redirect, an evicted body). */
  body(): Promise<Buffer>;
}

/** What an attempt's network applies, and how it tells the attempt's events and failures. */
export interface AttemptNetworkOptions {
  /** Headers for every request bound for the app's site; names lowercased. */
  readonly siteHeaders: (url: string) => Readonly<Record<string, string>> | undefined;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
  /** Whether an event belongs to the attempt. */
  readonly ours: (event: { readonly userContext?: string | null; readonly context: string | null }) => boolean;
  /** Whether a context is the attempt's tab or a frame in it, which a response wait listens to. */
  readonly onPage: (context: string | null) => boolean;
  /** Whether no other client drives the browser, so one intercept can cover every tab from its first request. */
  readonly exclusive: boolean;
  /** The browser, whose request handling differs: Firefox keeps a replaced body's old `content-length` and sends no cookie a continue leaves out. */
  readonly browser: 'chromium' | 'firefox';
  /** Takes a failure on a path no step awaits (deciding a held request, answering a challenge), for the next step to fail with. */
  readonly onFailure: (error: Error) => void;
}

/** The window of no requests in flight Playwright's `networkidle` waits for. */
const NETWORK_IDLE_MS = 500;
/** The largest body a response wait keeps, per response. */
const MAX_COLLECTED_BODY = 20 * 1024 * 1024;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** One attempt's network: its intercepts, routes, auth answers, in-flight count, and response waits. */
export class AttemptNetwork {
  private routes: NetworkRoute[] = [];
  private userContext: string | undefined;
  /** The attempt's top-level tabs; intercepts cover exactly these, so a browser shared with other sessions keeps its own requests. */
  private readonly tops = new Set<string>();
  /** Tabs that closed, as their events said, before the queue caught up. */
  private readonly closedTabs = new Set<string>();
  /** Whether every request is held: site headers to add, or a route registered. */
  private holding: boolean;
  /** Top-level tabs whose every document request is answered with a blank page (`serveBlank`), before any route. */
  private readonly blank = new Set<string>();
  private intercept: string | undefined;
  private authIntercept: string | undefined;
  /** Every intercept this network added to the bound user context, so a request a replaced one still holds is decided. */
  private readonly intercepts = new Set<string>();
  private subscription: string | undefined;
  private collector: Promise<string> | undefined;
  private requestCollector: string | undefined;
  /** Removals that failed, tried again by the next release so nothing is forgotten while the browser still holds it. */
  private unreleased: (() => Promise<unknown>)[] = [];
  /** The headers each continued request went on with, and its method, for its redirect hops. */
  private readonly continuedHeaders = new Map<string, { headers: Record<string, string>; method: string }>();
  /** Bodies routes fulfilled, which a response wait reads since the browser keeps none of them. */
  private readonly fulfilledBodies = new Map<string, Buffer>();
  /** Listeners of response bodies still loading, ended with the network. */
  private readonly pendingBodies = new Set<() => void>();
  private readonly inflight = new Set<string>();
  private lastSettled = Date.now();
  private readonly answered = new Set<string>();
  private readonly listeners: (() => void)[] = [];
  /** Serializes changes to the intercepts and subscriptions, which each take round trips. */
  private changes: Promise<void> = Promise.resolve();

  constructor(
    private readonly connection: BidiConnection,
    private readonly options: AttemptNetworkOptions & { readonly holdAll: boolean },
  ) {
    this.holding = options.holdAll;
  }

  /** Whether anything needs the request events: held requests, credentials, or a listener already installed. */
  private get needsEvents(): boolean {
    return this.holds || this.options.credentials !== undefined || this.listeners.length > 0;
  }

  /** Whether requests are held: for headers or routes, or for a blank-served tab. */
  private get holds(): boolean {
    return this.holding || this.blank.size > 0;
  }

  /** Runs `work` after every earlier change; a failed change rejects its caller and lets the next run. */
  private change(work: () => Promise<void>): Promise<void> {
    const next = this.changes.then(work);
    this.changes = releaseQuietly(next);
    return next;
  }

  /**
   * Binds the network to a fresh user context (the attempt's first, or the
   * one a reset or restore replaced it with): its subscription and
   * collectors follow it, and its tabs start empty. The response collector
   * starts here, so a response wait has nothing to set up before the action
   * it waits on can fire the response.
   */
  bind(userContext: string): Promise<void> {
    return this.change(async () => {
      await this.release();
      this.userContext = userContext;
      this.tops.clear();
      this.closedTabs.clear();
      if (this.needsEvents) await this.subscribe();
      await this.collectResponses();
    });
  }

  /** A top-level tab of the attempt opened: the intercepts cover it from now on. */
  addContext(context: string): Promise<void> {
    this.closedTabs.delete(context);
    return this.change(async () => {
      if (this.closedTabs.has(context)) return;
      this.tops.add(context);
      await this.refreshIntercepts();
    });
  }

  /**
   * A top-level tab of the attempt closed. It is marked closed at once, so a
   * queued addition or intercept refresh leaves it out instead of covering a
   * tab that no longer exists.
   */
  removeContext(context: string): Promise<void> {
    this.closedTabs.add(context);
    return this.change(async () => {
      if (this.tops.delete(context)) await this.refreshIntercepts();
    });
  }

  /** Subscribes to the request events of the bound user context, and collects request bodies while requests are held. */
  private async subscribe(): Promise<void> {
    const connection = this.connection;
    const userContext = this.userContext;
    if (userContext === undefined || this.subscription !== undefined) return;
    if (this.listeners.length === 0) {
      this.listeners.push(
        connection.on('network.beforeRequestSent', (event) => this.onRequest(event)),
        connection.on('network.responseCompleted', (event) => this.settle(event)),
        connection.on('network.fetchError', (event) => this.settle(event)),
        connection.on('network.authRequired', (event) => this.onAuth(event)),
      );
    }
    const { subscription } = await connection.send('session.subscribe', {
      events: ['network.beforeRequestSent', 'network.authRequired'],
      userContexts: [userContext],
    });
    this.subscription = subscription;
    if (this.holding && this.requestCollector === undefined) {
      this.requestCollector = (await connection.send('network.addDataCollector', {
        dataTypes: ['request'],
        maxEncodedDataSize: MAX_COLLECTED_BODY,
        userContexts: [userContext],
      })).collector;
    }
  }

  /**
   * Brings the intercepts in line with what the attempt needs. On a browser
   * no other client drives, one intercept covers every tab, so a tab the app
   * opens is held from its first request; otherwise each covers the current
   * tabs exactly, so other clients keep their own requests, and is replaced,
   * the new one in place before the old goes. A tab that closes while its
   * intercept is being added is left out and the intercept added again.
   */
  private async refreshIntercepts(): Promise<void> {
    const connection = this.connection;
    const live = (): string[] => [...this.tops].filter((context) => !this.closedTabs.has(context));
    const add = async (phase: 'beforeRequestSent' | 'authRequired'): Promise<string> => {
      for (;;) {
        const contexts = live();
        try {
          const { intercept } = await connection.send('network.addIntercept', {
            phases: [phase],
            ...(this.options.exclusive ? {} : { contexts: contexts as [string, ...string[]] }),
          });
          this.intercepts.add(intercept);
          return intercept;
        } catch (cause) {
          if (live().length === contexts.length) throw cause;
        }
      }
    };
    const replace = async (wanted: boolean, phase: 'beforeRequestSent' | 'authRequired', old: string | undefined, keep: (intercept: string | undefined) => void): Promise<void> => {
      if (this.options.exclusive) {
        keep(wanted ? (old ?? (await add(phase))) : old);
        return;
      }
      keep(wanted && live().length > 0 ? await add(phase) : undefined);
      if (old !== undefined) await alreadyGone(connection.send('network.removeIntercept', { intercept: old }), connection);
    };
    await replace(this.holds, 'beforeRequestSent', this.intercept, (intercept) => (this.intercept = intercept));
    await replace(this.options.credentials !== undefined, 'authRequired', this.authIntercept, (intercept) => (this.authIntercept = intercept));
  }

  /**
   * Answers every document request of `context`, a tab of the attempt, with
   * a blank page before any route sees it, so a page at an origin can run
   * script without the app's server seeing a request. Returns the undo.
   */
  async serveBlank(context: string): Promise<() => Promise<void>> {
    await this.change(async () => {
      this.blank.add(context);
      this.tops.add(context);
      await this.subscribe();
      await this.refreshIntercepts();
    });
    return () => this.change(async () => {
      this.blank.delete(context);
    });
  }

  /**
   * Starts counting the attempt's requests in flight, for a `networkidle`
   * wait. Call it before the navigation the wait follows.
   */
  track(): Promise<void> {
    return this.change(() => this.subscribe());
  }

  /** Registers a route for every request from now on; the newest route sees a request first. */
  addRoute(route: NetworkRoute): Promise<void> {
    return this.change(async () => {
      this.routes.push(route);
      if (this.holding) return;
      this.holding = true;
      await this.subscribe();
      if (this.requestCollector === undefined && this.userContext !== undefined) {
        this.requestCollector = (await this.connection.send('network.addDataCollector', {
          dataTypes: ['request'],
          maxEncodedDataSize: MAX_COLLECTED_BODY,
          userContexts: [this.userContext],
        })).collector;
      }
      await this.refreshIntercepts();
    });
  }

  /** Removes the routes `match` selects. */
  removeRoutes(match: (route: NetworkRoute) => boolean): void {
    this.routes = this.routes.filter((route) => !match(route));
  }

  /**
   * Counts the attempt's request in flight (an EventSource stream never
   * settles, so it does not count) and, when one of this network's
   * intercepts holds it, decides it as Playwright does: a held request of
   * another user context or of no frame goes on untouched, a site icon is
   * aborted, a redirect hop goes on with what its first hop was continued
   * with, a CORS preflight is answered while routes are set, and the rest
   * go through the routes.
   */
  private onRequest(event: BidiEventParams<'network.beforeRequestSent'>): void {
    const request = event.request.request;
    const blocked = event.isBlocked && (event.intercepts ?? []).some((intercept) => this.intercepts.has(intercept));
    const pass = (overrides: Partial<Network.ContinueRequestParameters> = {}): void => {
      void this.connection.send('network.continueRequest', { request, ...overrides }).catch((cause: unknown) => this.fail(cause));
    };
    if (!this.options.ours(event)) {
      if (blocked) pass();
      return;
    }
    const headers = headerRecord(event.request.headers);
    if (this.options.onPage(event.context) && headers['accept'] !== 'text/event-stream') this.inflight.add(request);
    if (!blocked) return;
    if (event.context === null) {
      pass();
      return;
    }
    if (stripHash(event.request.url).endsWith('/favicon.ico')) {
      void unlessCancelled(this.connection.send('network.failRequest', { request })).catch((cause: unknown) => this.fail(cause));
      return;
    }
    if (event.redirectCount > 0) {
      pass(this.redirectHeaders(event, headers));
      return;
    }
    if (event.request.method === 'OPTIONS' && headers['access-control-request-method'] !== undefined && this.routes.length > 0) {
      void this.answerPreflight(request, headers).catch((cause: unknown) => this.fail(cause));
      return;
    }
    const decide = this.blank.has(event.context) ? this.answerBlank(event) : this.route(event);
    void decide.catch(async (cause: unknown) => {
      await releaseQuietly(this.connection.send('network.failRequest', { request }));
      this.fail(cause);
    });
  }

  /**
   * The headers a redirect hop of a request a route continued goes on with:
   * the route's overrides applied again to the hop's own headers, as
   * Playwright does (a redirect is never routed again), without the body's
   * headers when the redirect turned a POST into a GET; the site headers
   * otherwise.
   */
  private redirectHeaders(event: BidiEventParams<'network.beforeRequestSent'>, headers: Record<string, string>): Partial<Network.ContinueRequestParameters> {
    const continued = this.continuedHeaders.get(event.request.request);
    const site = this.options.siteHeaders(stripHash(event.request.url));
    if (continued === undefined) return site === undefined ? {} : { headers: wireHeaders({ ...headers, ...site }) };
    const applied = { ...applyHeaderOverrides(headers, continued.headers, this.options.browser === 'chromium'), ...site };
    if (continued.method === 'POST' && event.request.method === 'GET') {
      for (const name of REQUEST_BODY_HEADERS) delete applied[name];
    }
    return { headers: wireHeaders(applied) };
  }

  /** Answers a CORS preflight while routes are set, accepting it as Playwright does: a route on the URL means the test meant the request to go. */
  private async answerPreflight(request: string, headers: Record<string, string>): Promise<void> {
    const answer: Record<string, string> = {
      'access-control-allow-origin': headers['origin'] ?? '*',
      'access-control-allow-methods': headers['access-control-request-method'] ?? '',
      'access-control-allow-credentials': 'true',
      ...(headers['access-control-request-headers'] === undefined ? {} : { 'access-control-allow-headers': headers['access-control-request-headers'] }),
    };
    await this.connection.send('network.provideResponse', { request, statusCode: 204, reasonPhrase: 'No Content', headers: wireHeaders(answer) });
  }

  /** Answers a document request with an empty page; any other request of a blank-served tab fails. */
  private async answerBlank(event: BidiEventParams<'network.beforeRequestSent'>): Promise<void> {
    const request = event.request.request;
    if (event.navigation === null) {
      await this.connection.send('network.failRequest', { request });
      return;
    }
    await this.connection.send('network.provideResponse', {
      request,
      statusCode: 200,
      headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html' } }],
      body: { type: 'string', value: '<!doctype html><title></title>' },
    });
  }

  /**
   * Hands a failure of an unawaited path to the attempt. A request the
   * browser already let go (the page navigated away under it, or cancelled
   * it) is no failure.
   */
  private fail(cause: unknown): void {
    if (cancelledRequest(cause)) return;
    this.options.onFailure(cause instanceof Error ? cause : new Error(String(cause)));
  }

  /** Runs the matching routes newest first, then lets the request through with the site headers. */
  private async route(event: BidiEventParams<'network.beforeRequestSent'>): Promise<void> {
    const request = event.request;
    const address = stripHash(request.url);
    const url = URL.canParse(address) ? new URL(address) : undefined;
    const matching = url === undefined ? [] : this.routes.filter((route) => route.predicate(url)).toReversed();
    const intercepted: InterceptedRequest = {
      id: request.request,
      url: address,
      method: request.method,
      headers: headerRecord(request.headers),
      ...(request.cookies.length === 0 ? {} : { cookie: request.cookies.map((cookie) => `${cookie.name}=${bytesText(cookie.value)}`).join('; ') }),
      ...(matching.length === 0 ? {} : await this.postData(request, event.navigation !== null)),
    };
    for (const route of matching) {
      let passed = false;
      await route.handle(intercepted, {
        continue: (overrides) => unlessCancelled(this.continue(intercepted, overrides)),
        fulfill: (response) => unlessCancelled(this.fulfill(intercepted, response)),
        abort: () => unlessCancelled(this.connection.send('network.failRequest', { request: intercepted.id })),
        fallback: async () => {
          passed = true;
        },
      });
      if (!passed) return;
    }
    await unlessCancelled(this.continue(intercepted));
  }

  /**
   * The request's body when the collector kept one, as text and bytes; a
   * body it did not keep (too large, a stream) is marked unavailable. So is
   * a held navigation's on Chromium, which never answers for the body of a
   * paused form submission (https://github.com/puppeteer/puppeteer/pull/15607).
   */
  private async postData(request: Network.RequestData, navigation: boolean): Promise<{ postData?: string; body?: Buffer; bodyUnavailable?: true }> {
    if (request.bodySize === 0 || (request.bodySize === null && ['GET', 'HEAD'].includes(request.method))) return {};
    if (this.requestCollector === undefined || (navigation && this.options.browser === 'chromium')) return { bodyUnavailable: true };
    try {
      const { bytes } = await this.connection.send('network.getData', { dataType: 'request', request: request.request, collector: this.requestCollector });
      const body = bytes.type === 'string' ? Buffer.from(bytes.value) : Buffer.from(bytes.value, 'base64');
      return { postData: body.toString(), body };
    } catch (cause) {
      if (cause instanceof BidiError && cause.error === 'no such network data') return { bodyUnavailable: true };
      throw cause;
    }
  }

  /**
   * Lets a held request go on, with its overrides and, for the app's site,
   * the configured headers. Header overrides follow Playwright's rules: a
   * header the browser owns (cookie, host, origin, content-length, `sec-*`
   * and the like) keeps the browser's value, and a new body sets its own
   * `content-length` on a browser that would keep the old one. The headers sent are kept for the request's redirect
   * hops (`redirectHeaders`).
   */
  private async continue(
    request: InterceptedRequest,
    overrides: { url?: string; method?: string; headers?: Record<string, string>; postData?: string } = {},
  ): Promise<void> {
    const site = this.options.siteHeaders(overrides.url ?? request.url);
    let headers = overrides.headers === undefined ? undefined : applyHeaderOverrides(request.headers, lowercaseNames(overrides.headers), this.options.browser === 'chromium');
    if (overrides.postData !== undefined && this.options.browser === 'firefox') headers = { ...(headers ?? request.headers), 'content-length': String(Buffer.byteLength(overrides.postData)) };
    if (site !== undefined) headers = { ...(headers ?? request.headers), ...site };
    if (headers !== undefined) this.continuedHeaders.set(request.id, { headers, method: overrides.method ?? request.method });
    await this.connection.send('network.continueRequest', {
      request: request.id,
      ...(overrides.url === undefined ? {} : { url: overrides.url }),
      ...(overrides.method === undefined ? {} : { method: overrides.method }),
      ...(headers === undefined ? {} : { headers: wireHeaders(headers) }),
      ...(overrides.postData === undefined ? {} : { body: { type: 'string' as const, value: overrides.postData } }),
    });
  }

  /**
   * Answers a held request with a response the test wrote; a `path` body's
   * type follows its extension. As Playwright's fulfill: the status carries
   * its reason phrase, a cross-origin request gets CORS headers unless the
   * response sets its own, and the body is kept for a response wait to read,
   * since a browser keeps no body it did not load.
   */
  private async fulfill(
    request: InterceptedRequest,
    response: { status: number; headers: Record<string, string>; contentType?: string; body?: string | Uint8Array; json?: unknown; path?: string },
  ): Promise<void> {
    const headers = { ...lowercaseNames(response.headers) };
    let body: Buffer;
    if (response.json !== undefined) {
      body = Buffer.from(JSON.stringify(response.json));
      headers['content-type'] ??= 'application/json';
    } else if (response.path !== undefined) {
      body = await readFile(response.path);
      const type = CONTENT_TYPES[path.extname(response.path).toLowerCase()];
      if (type !== undefined) headers['content-type'] ??= type;
    } else {
      body = Buffer.from(response.body ?? '');
    }
    if (response.contentType !== undefined) headers['content-type'] = response.contentType;
    const origin = request.headers['origin'];
    if (origin !== undefined && URL.canParse(request.url) && new URL(request.url).origin !== origin.trim() && headers['access-control-allow-origin'] === undefined) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-credentials'] = 'true';
      headers['vary'] = 'Origin';
    }
    this.fulfilledBodies.set(request.id, body);
    await this.connection.send('network.provideResponse', {
      request: request.id,
      statusCode: response.status,
      reasonPhrase: STATUS_CODES[response.status] ?? 'Unknown',
      headers: wireHeaders(headers),
      body: { type: 'base64', value: body.toString('base64') },
    });
  }

  /** Answers the attempt's basic-auth challenge with the credentials once; a second one for the same request means they were refused, and lets the 401 through. */
  private onAuth(event: BidiEventParams<'network.authRequired'>): void {
    const credentials = this.options.credentials;
    if (!this.options.ours(event) || !event.isBlocked || credentials === undefined) return;
    // A second challenge for the same request means the credentials were refused; it gets the 401.
    const retry = this.answered.has(event.request.request);
    this.answered.add(event.request.request);
    void this.connection
      .send('network.continueWithAuth', retry
        ? { request: event.request.request, action: 'cancel' }
        : { request: event.request.request, action: 'provideCredentials', credentials: { type: 'password', ...credentials } })
      .catch((cause: unknown) => this.fail(cause));
  }

  /** A request finished: once none is in flight, the idle window starts. */
  private settle(event: { readonly request: Network.RequestData; readonly userContext?: string | null; readonly context: string | null; readonly response?: Network.ResponseData }): void {
    const status = event.response?.status ?? 0;
    if (status < 300 || status >= 400) this.continuedHeaders.delete(event.request.request);
    if (!this.inflight.delete(event.request.request)) return;
    if (this.inflight.size === 0) this.lastSettled = Date.now();
  }

  /**
   * Resolves once no request of the attempt's tab has been in flight for
   * 500 ms, Playwright's `networkidle`; a tab the app opened does not count.
   * `track` must have run before the navigation it follows, so the requests
   * it started were counted.
   */
  async waitForIdle(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      if (this.inflight.size === 0 && Date.now() - this.lastSettled >= NETWORK_IDLE_MS) return;
      const wait = this.inflight.size === 0 ? NETWORK_IDLE_MS - (Date.now() - this.lastSettled) : 50;
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, wait)));
    }
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive (`network.responseStarted`, in the
   * session's subscription); start the wait before the action that triggers
   * the response. Its body comes from the attempt's response collector, and
   * reading it waits for the load to finish. Loads that finish are
   * tracked from the call on too, so one that completes in the same burst as
   * its headers is never missed.
   */
  async waitForResponse(matches: (url: string) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const connection = this.connection;
    const wanted = (event: { readonly context: string | null; readonly request: Network.RequestData }): boolean =>
      this.options.onPage(event.context) && matches(stripHash(event.request.url));
    const finished = new Map<string, string | null>();
    let matched: string | undefined;
    let settled: () => void = () => undefined;
    const ended = (event: { readonly context: string | null; readonly request: Network.RequestData }, failure: string | null): void => {
      if (matched === undefined ? !wanted(event) : event.request.request !== matched) return;
      finished.set(event.request.request, failure);
      settled();
    };
    const offs = [
      connection.on('network.responseCompleted', (event) => ended(event, null)),
      connection.on('network.fetchError', (event) => ended(event, event.errorText)),
    ];
    const stop = (): void => {
      for (const off of offs.splice(0)) off();
      this.pendingBodies.delete(stop);
    };
    this.pendingBodies.add(stop);
    let started: (event: BidiEventParams<'network.responseStarted'>) => void = () => undefined;
    const first = new Promise<BidiEventParams<'network.responseStarted'>>((resolve) => (started = resolve));
    const offStart = connection.on('network.responseStarted', (event) => {
      if (this.options.onPage(event.context) && matches(stripHash(event.response.url))) started(event);
    });
    try {
      const collector = await this.collectResponses();
      const event = await raceAbort(first, signal, 'waitForResponse');
      const request = event.request.request;
      matched = request;
      for (const id of finished.keys()) if (id !== request) finished.delete(id);
      const loaded = new Promise<void>((resolve, reject) => {
        settled = () => {
          if (!finished.has(request)) return;
          stop();
          const failure = finished.get(request);
          if (failure == null) resolve();
          else reject(new Error(failure));
        };
        settled();
      });
      loaded.catch(() => undefined);
      return {
        url: stripHash(event.response.url),
        status: event.response.status,
        headers: headerRecord(event.response.headers),
        body: async () => {
          await loaded;
          const fulfilled = this.fulfilledBodies.get(request);
          if (fulfilled !== undefined) return fulfilled;
          const data = await connection.send('network.getData', { dataType: 'response', request, collector });
          return data.bytes.type === 'string' ? Buffer.from(data.bytes.value) : Buffer.from(data.bytes.value, 'base64');
        },
      };
    } catch (cause) {
      stop();
      throw cause;
    } finally {
      offStart();
    }
  }

  /** The bound user context's response collector, added once however many waits ask at the same time. */
  private collectResponses(): Promise<string> {
    const userContext = this.userContext;
    this.collector ??= this.connection.send('network.addDataCollector', {
      dataTypes: ['response'],
      maxEncodedDataSize: MAX_COLLECTED_BODY,
      ...(userContext === undefined ? {} : { userContexts: [userContext] }),
    }).then(({ collector }) => collector);
    const pending = this.collector;
    pending.catch(() => {
      if (this.collector === pending) this.collector = undefined;
    });
    return pending;
  }

  /**
   * Removes the bound user context's intercepts (every one this network
   * added, so one a failed replacement left behind goes too), collectors,
   * and subscription, every one attempted; one the browser no longer has is
   * done, any other failure is thrown so the attempt's close reports it and
   * the browser is retired rather than reused with it in place.
   */
  private async release(): Promise<void> {
    const connection = this.connection;
    const collector = this.collector;
    const removals: (() => Promise<unknown>)[] = [
      ...this.unreleased,
      ...[...this.intercepts].map((intercept) => () => connection.send('network.removeIntercept', { intercept })),
      ...(collector === undefined ? [] : [() => collector.then((id) => connection.send('network.removeDataCollector', { collector: id }))]),
      ...(this.requestCollector === undefined ? [] : [((id: string) => () => connection.send('network.removeDataCollector', { collector: id }))(this.requestCollector)]),
      ...(this.subscription === undefined ? [] : [((id: string) => () => connection.send('session.unsubscribe', { subscriptions: [id] }))(this.subscription)]),
    ];
    this.intercept = this.authIntercept = this.collector = this.requestCollector = this.subscription = undefined;
    this.intercepts.clear();
    this.blank.clear();
    const results = await Promise.allSettled(removals.map((removal) => alreadyGone(removal(), connection)));
    this.unreleased = removals.filter((_removal, index) => results[index]!.status === 'rejected');
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }


  /** Ends the attempt's network: listeners, routes, intercepts, collectors, and subscription. */
  async dispose(): Promise<void> {
    for (const off of this.listeners.splice(0)) off();
    for (const stop of this.pendingBodies) stop();
    this.routes = [];
    await this.change(() => this.release());
  }
}

/** BiDi headers as a record, names lowercased; a repeated name keeps its values joined, as Playwright reports them. */
function headerRecord(headers: readonly Network.Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = bytesText(header.value);
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

/** Headers a route may not override, as Playwright's `isForbiddenHeader` names them: the browser's value stands. */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'via',
]);

/** The headers of a request body, which a redirect from a POST to a GET drops. */
const REQUEST_BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

/** Whether a route may not override header `name` (with `value`), Playwright's rule. */
function isForbiddenHeader(name: string, value: string): boolean {
  if (FORBIDDEN_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) return true;
  return ['x-http-method', 'x-http-method-override', 'x-method-override'].includes(name) && ['CONNECT', 'TRACE', 'TRACK'].includes(value.toUpperCase());
}

/**
 * A route's header overrides applied to the request's own headers, as
 * Playwright's `applyHeadersOverrides`: the browser's forbidden headers stay,
 * the route's others replace the rest. With `freshCookies` (Chromium, which
 * adds them itself) the cookie header is left out, so the browser sends the
 * cookies its store holds when the request goes, not the ones it held when it
 * was held.
 */
function applyHeaderOverrides(original: Readonly<Record<string, string>>, overrides: Readonly<Record<string, string>>, freshCookies: boolean): Record<string, string> {
  const kept = Object.entries(original).filter(([name, value]) => isForbiddenHeader(name, value) && !(freshCookies && name === 'cookie'));
  const allowed = Object.entries(overrides).filter(([name, value]) => !isForbiddenHeader(name, value));
  return Object.fromEntries([...allowed, ...kept]);
}

/** Whether a decision failed because the page already cancelled the request it decides: no failure, as Playwright sends such decisions "may fail". */
function cancelledRequest(cause: unknown): boolean {
  return cause instanceof BidiError && (cause.error === 'no such request' || /Invalid InterceptionId/i.test(cause.message));
}

/** Waits for a decision on a held request, taking one the page already cancelled as made. */
async function unlessCancelled(decision: Promise<unknown>): Promise<void> {
  try {
    await decision;
  } catch (cause) {
    if (!cancelledRequest(cause)) throw cause;
  }
}

/** A URL without its fragment, which no request carries to the server and Playwright never reports. */
function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Errors that mean what a removal removes is already gone: the browser dropped it, or the browser itself is gone. */
const GONE = new Set(['no such intercept', 'no such network collector', 'no such network data', 'invalid argument']);

/** Waits for a removal, taking a resource the browser no longer has (or a browser that is gone) as removed. */
async function alreadyGone(removal: Promise<unknown> | undefined, connection: BidiConnection): Promise<void> {
  try {
    await removal;
  } catch (cause) {
    if (connection.isClosed || (cause instanceof BidiError && GONE.has(cause.error))) return;
    throw cause;
  }
}

/** A BiDi bytes value as text. */
function bytesText(value: Network.BytesValue): string {
  return value.type === 'string' ? value.value : Buffer.from(value.value, 'base64').toString();
}


/** A header record as BiDi headers. */
function wireHeaders(headers: Readonly<Record<string, string>>): Network.Header[] {
  return Object.entries(headers).flatMap(([name, value]) => (name.toLowerCase() === 'set-cookie' ? value.split('\n') : [value]).map((one) => ({ name, value: { type: 'string' as const, value: one } })));
}

