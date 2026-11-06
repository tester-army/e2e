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
import type { TextPattern } from 'e2e/engine';
import { BidiError, type BidiConnection, type BidiEventParams } from './connection.ts';
import type { ContextTree } from './context-tree.ts';
import { lowercaseNames } from '../protected-app.ts';
import type { ContinueDecision, FulfillDecision } from '../route-options.ts';
import { routePatternMatches } from '../route-pattern.ts';
import { releaseQuietly } from './errors.ts';
import { NetworkBinding, alreadyGone, bytesText, headerRecord, stripHash, type NetworkWants, type ObservedResponse } from './network-binding.ts';

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
  continue(decision: ContinueDecision): Promise<void>;
  fulfill(decision: FulfillDecision): Promise<void>;
  abort(): Promise<void>;
  /** Hands the request to the next older matching route, or to the network. */
  fallback(): Promise<void>;
}

/** One registered route: the URL pattern it takes, and what it does with each request. */
export interface NetworkRoute {
  readonly pattern: TextPattern;
  readonly handle: (request: InterceptedRequest, decisions: RouteDecisions) => Promise<void>;
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
  /** The browsing-context tree, whose subtree of a closed context has its requests retired with it. */
  readonly contexts: ContextTree;
  /** Whether no other client drives the browser, so one intercept can cover every tab from its first request. */
  readonly exclusive: boolean;
  /** The browser, whose request handling differs: Firefox keeps a replaced body's old `content-length` and sends no cookie a continue leaves out. */
  readonly browser: 'chromium' | 'firefox';
  /** Takes a failure on a path no step awaits (deciding a held request, answering a challenge), for the next step to fail with. */
  readonly onFailure: (error: Error) => void;
  /** Takes the URL of a document request a test route aborted in `context`, before the abort goes out. */
  readonly onNavigationAbort: (context: string, url: string) => void;
}

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

/** One attempt's network: its routes and policy, and the binding to the current user context that carries out both. */
export class AttemptNetwork {
  private routes: NetworkRoute[] = [];
  /** Whether requests in flight are counted, once a `networkidle` wait asked for it. */
  private tracking = false;
  /** The current user context's state and resources; replaced whole by `bind`. */
  private binding: NetworkBinding | undefined;
  /** Removals that failed, tried again by the next release so nothing is forgotten while the browser still holds it. */
  private unreleased: (() => Promise<unknown>)[] = [];
  /** Serializes changes to the intercepts and subscriptions, which each take round trips. */
  private changes: Promise<void> = Promise.resolve();
  private readonly offClose: () => void;

  constructor(
    private readonly connection: BidiConnection,
    private readonly options: AttemptNetworkOptions & { readonly holdAll: boolean },
  ) {
    this.offClose = connection.onClose(() => this.binding?.endWaits(new Error('the BiDi connection closed before the response finished loading')));
  }

  /** Runs `work` after every earlier change; a failed change rejects its caller and lets the next run. */
  private change(work: () => Promise<void>): Promise<void> {
    const next = this.changes.then(work);
    this.changes = releaseQuietly(next);
    return next;
  }

  /** Installs what the attempt's routes, headers, credentials, and waits need on the bound user context, whatever an earlier try left out, and removes what nothing needs any more. */
  private async reconcile(): Promise<void> {
    const wants: NetworkWants = {
      holdAll: this.options.holdAll,
      routes: this.routes.length,
      tracking: this.tracking,
      challenges: this.options.credentials !== undefined || this.options.browser === 'firefox',
    };
    await this.binding?.reconcile(wants);
  }

  /**
   * Binds the network to a fresh user context (the attempt's first, or the
   * one a reset or restore replaced it with). The old binding ends first,
   * with every request it tracked, and its resources are removed; the new
   * one starts with no tabs and no requests. The response collector starts
   * here, so a response wait has nothing to set up before the action it
   * waits on can fire the response.
   */
  bind(userContext: string): Promise<void> {
    return this.change(async () => {
      const old = this.binding;
      this.binding = undefined;
      old?.close();
      await this.release(old);
      this.binding = new NetworkBinding(this.connection, userContext, {
        exclusive: this.options.exclusive,
        contexts: this.options.contexts,
        ours: this.options.ours,
        listen: (binding) => this.listen(binding),
      });
      await this.reconcile();
    });
  }

  /** Starts the request event listeners of `binding`; they end with it. */
  private listen(binding: NetworkBinding): (() => void)[] {
    const connection = this.connection;
    return [
      connection.on('network.beforeRequestSent', (event) => this.onRequest(binding, event)),
      connection.on('network.authRequired', (event) => this.onAuth(binding, event)),
    ];
  }

  /**
   * A top-level tab of the attempt opened: the intercepts cover it from now
   * on. A tab the context tree no longer knows closed before the queue
   * caught up, and is left out instead of covering a tab that no longer exists.
   */
  addContext(context: string): Promise<void> {
    const binding = this.binding;
    return this.change(async () => {
      if (binding !== undefined && binding === this.binding && binding.cover(context)) await this.reconcile();
    });
  }

  /** A top-level tab of the attempt closed: its requests in flight stop counting, and the intercepts stop covering it. */
  removeContext(context: string): Promise<void> {
    const binding = this.binding;
    this.retire(context);
    return this.change(async () => {
      if (binding !== undefined && binding === this.binding && binding.uncover(context)) await this.reconcile();
    });
  }

  /**
   * A browsing context of the attempt (a tab or a frame) closed: the
   * requests in flight from it and every frame in it stop counting, whatever
   * events their teardown still sends. Call it before the tree forgets them.
   */
  retire(context: string): void {
    this.binding?.retire(this.options.contexts.subtree(context));
  }

  /**
   * Answers every document request of `context`, a tab of the attempt, with
   * a blank page before any route sees it, so a page at an origin can run
   * script without the app's server seeing a request. Returns the undo.
   */
  async serveBlank(context: string): Promise<() => Promise<void>> {
    let binding: NetworkBinding | undefined;
    await this.change(async () => {
      binding = this.binding;
      binding?.serveBlank(context);
      await this.reconcile();
    });
    return () => this.change(async () => {
      binding?.unserveBlank(context);
      if (binding !== undefined && binding === this.binding) await this.reconcile();
    });
  }

  /**
   * Starts counting the attempt's requests in flight, for a `networkidle`
   * wait. Call it before the navigation the wait follows.
   */
  track(): Promise<void> {
    return this.change(async () => {
      this.tracking = true;
      await this.reconcile();
    });
  }

  /**
   * Registers a route for every request from now on; the newest route sees a
   * request first. The route counts only once what holds requests for it is
   * installed; a failed install takes it back out.
   */
  addRoute(route: NetworkRoute): Promise<void> {
    return this.change(async () => {
      this.routes.push(route);
      try {
        await this.reconcile();
      } catch (cause) {
        this.routes = this.routes.filter((one) => one !== route);
        throw cause;
      }
    });
  }

  /**
   * Removes the routes `match` selects, in order with the additions before
   * it, and lets interception go once nothing needs requests held.
   */
  removeRoutes(match: (route: NetworkRoute) => boolean): Promise<void> {
    return this.change(async () => {
      this.routes = this.routes.filter((route) => !match(route));
      await this.reconcile();
    });
  }

  /**
   * Counts the attempt's request in flight (an EventSource stream never
   * settles, so it does not count) and, when one of the binding's intercepts
   * holds it, decides it as Playwright does: a held request of another user
   * context or of no frame goes on untouched, a redirect hop goes on with what its first hop was continued with, a CORS
   * preflight is answered while routes are set, and the rest go through the
   * routes.
   */
  private onRequest(binding: NetworkBinding, event: BidiEventParams<'network.beforeRequestSent'>): void {
    const request = event.request.request;
    const blocked = binding.holds(event);
    const pass = (overrides: Partial<Network.ContinueRequestParameters> = {}): void => {
      void this.connection.send('network.continueRequest', { request, ...overrides }).catch((cause: unknown) => this.fail(cause));
    };
    if (!this.options.ours(event)) {
      if (blocked) pass();
      return;
    }
    const headers = headerRecord(event.request.headers);
    if (event.context !== null) binding.started(request, event.context, this.options.onPage(event.context) && headers['accept'] !== 'text/event-stream');
    if (!blocked) return;
    if (event.context === null) {
      pass();
      return;
    }
    if (event.redirectCount > 0) {
      pass(this.redirectHeaders(binding, event, headers));
      return;
    }
    if (event.request.method === 'OPTIONS' && headers['access-control-request-method'] !== undefined && this.routes.length > 0) {
      void this.answerPreflight(request, headers).catch((cause: unknown) => this.fail(cause));
      return;
    }
    const decide = binding.isBlank(event.context) ? this.answerBlank(event) : this.route(binding, event);
    void decide.catch(async (cause: unknown) => {
      await releaseQuietly(this.connection.send('network.failRequest', { request }));
      this.fail(cause);
    });
  }

  /**
   * The headers a redirect hop goes on with: the hop's own headers, without
   * the site headers the driver added to the previous hop; the route's
   * overrides applied again, as Playwright does (a redirect is never routed
   * again), without the body's headers when the redirect turned a POST into
   * a GET; then the site headers of the hop's own URL, if any. A hop with
   * nothing to change goes on untouched.
   */
  private redirectHeaders(binding: NetworkBinding, event: BidiEventParams<'network.beforeRequestSent'>, headers: Record<string, string>): Partial<Network.ContinueRequestParameters> {
    const id = event.request.request;
    const policy = binding.redirectPolicy(id);
    const site = this.options.siteHeaders(stripHash(event.request.url));
    let applied = policy?.injected === undefined ? headers : withoutInjected(headers, policy.injected);
    if (policy?.overrides !== undefined) {
      applied = applyHeaderOverrides(applied, policy.overrides, this.options.browser === 'chromium');
      if (policy.method === 'POST' && event.request.method === 'GET') {
        for (const name of REQUEST_BODY_HEADERS) delete applied[name];
      }
    }
    if (site !== undefined) applied = { ...applied, ...site };
    if (policy !== undefined || site !== undefined) {
      binding.keepRedirectPolicy(id, {
        ...(policy?.overrides === undefined ? {} : { overrides: policy.overrides }),
        method: policy?.method ?? event.request.method,
        ...(site === undefined ? {} : { injected: site }),
      });
    }
    return applied === headers ? {} : { headers: wireHeaders(applied) };
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
  private async route(binding: NetworkBinding, event: BidiEventParams<'network.beforeRequestSent'>): Promise<void> {
    const request = event.request;
    const address = stripHash(request.url);
    const url = URL.canParse(address) ? new URL(address) : undefined;
    const matching = url === undefined ? [] : this.routes.filter((route) => routePatternMatches(route.pattern, url.href)).toReversed();
    const intercepted: InterceptedRequest = {
      id: request.request,
      url: address,
      method: request.method,
      headers: headerRecord(request.headers),
      ...(request.cookies.length === 0 ? {} : { cookie: request.cookies.map((cookie) => `${cookie.name}=${bytesText(cookie.value)}`).join('; ') }),
      ...(matching.length === 0 ? {} : await this.postData(binding, request, event.navigation !== null)),
    };
    for (const route of matching) {
      let passed = false;
      await route.handle(intercepted, {
        continue: (decision) => unlessCancelled(this.continue(binding, intercepted, decision)),
        fulfill: (response) => unlessCancelled(this.fulfill(binding, intercepted, response)),
        abort: () => {
          if (event.navigation !== null && event.context !== null) this.options.onNavigationAbort(event.context, address);
          return unlessCancelled(this.connection.send('network.failRequest', { request: intercepted.id }));
        },
        fallback: async () => {
          passed = true;
        },
      });
      if (!passed) return;
    }
    await unlessCancelled(this.continue(binding, intercepted));
  }

  /**
   * The request's body when the collector kept one, as text and bytes; a
   * body it did not keep (too large, a stream) is marked unavailable. So is
   * a held navigation's on Chromium, which never answers for the body of a
   * paused form submission (https://github.com/puppeteer/puppeteer/pull/15607).
   */
  private async postData(binding: NetworkBinding, request: Network.RequestData, navigation: boolean): Promise<{ postData?: string; body?: Buffer; bodyUnavailable?: true }> {
    if (request.bodySize === 0 || (request.bodySize === null && ['GET', 'HEAD'].includes(request.method))) return {};
    const body = navigation && this.options.browser === 'chromium' ? undefined : await binding.requestBody(request.request);
    return body === undefined ? { bodyUnavailable: true } : { postData: body.toString(), body };
  }

  /**
   * Lets a held request go on, with its overrides and, for the app's site,
   * the configured headers. Header overrides follow Playwright's rules: a
   * header the browser owns (cookie, host, origin, content-length, `sec-*`
   * and the like) keeps the browser's value, and a new body sets its own
   * `content-length` on a browser that would keep the old one. The route's
   * header overrides and the site headers added are kept apart for the
   * request's redirect hops (`redirectHeaders`), so a hop that leaves the
   * site never carries the site's headers.
   */
  private async continue(binding: NetworkBinding, request: InterceptedRequest, overrides: ContinueDecision = {}): Promise<void> {
    const site = this.options.siteHeaders(overrides.url ?? request.url);
    const routeHeaders = overrides.headers === undefined ? undefined : lowercaseNames(overrides.headers);
    let headers = routeHeaders === undefined ? undefined : applyHeaderOverrides(request.headers, routeHeaders, this.options.browser === 'chromium');
    if (overrides.postData !== undefined && this.options.browser === 'firefox') headers = { ...(headers ?? request.headers), 'content-length': String(Buffer.byteLength(overrides.postData)) };
    if (site !== undefined) headers = { ...(headers ?? request.headers), ...site };
    if (routeHeaders !== undefined || site !== undefined) {
      binding.keepRedirectPolicy(request.id, {
        ...(routeHeaders === undefined ? {} : { overrides: routeHeaders }),
        method: overrides.method ?? request.method,
        ...(site === undefined ? {} : { injected: site }),
      });
    }
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
   * response sets its own, the body goes as the decoded bytes it is, framed
   * by its own length whatever `content-encoding` and `content-length` the
   * headers name (as `route.fetch`'s do, over a body it already decoded), and
   * it is kept for a response wait to read, since a browser keeps no body it
   * did not load.
   */
  private async fulfill(binding: NetworkBinding, request: InterceptedRequest, response: FulfillDecision): Promise<void> {
    const { 'content-encoding': _encoding, 'content-length': _length, ...given } = lowercaseNames(response.headers);
    const headers: Record<string, string> = { ...given };
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
    headers['content-length'] = String(body.length);
    binding.fulfilled(request.id, body);
    await this.connection.send('network.provideResponse', {
      request: request.id,
      statusCode: response.status,
      reasonPhrase: STATUS_CODES[response.status] ?? 'Unknown',
      headers: wireHeaders(headers),
      body: { type: 'base64', value: body.toString('base64') },
    });
  }

  /**
   * Answers a basic-auth challenge the binding holds: the attempt's with the
   * credentials once, a second one for the same request (the credentials
   * were refused) and any without credentials by letting the 401 through,
   * and another client's with the browser's default. Firefox's default is a
   * login prompt BiDi neither reports nor dismisses, which stalls the
   * navigation, so there challenges are held even without credentials.
   */
  private onAuth(binding: NetworkBinding, event: BidiEventParams<'network.authRequired'>): void {
    if (!binding.holds(event)) return;
    const request = event.request.request;
    const credentials = this.options.credentials;
    let answer: Network.ContinueWithAuthParameters;
    if (!this.options.ours(event)) answer = { request, action: 'default' };
    else if (credentials === undefined || binding.answerAuth(request, event.context ?? '')) answer = { request, action: 'cancel' };
    else answer = { request, action: 'provideCredentials', credentials: { type: 'password', ...credentials } };
    void this.connection.send('network.continueWithAuth', answer).catch((cause: unknown) => this.fail(cause));
  }

  /**
   * Resolves once no request of the attempt's tab has been in flight for
   * 500 ms, Playwright's `networkidle`; a tab the app opened does not count,
   * nor does a request of a user context the attempt has since replaced.
   * `track` must have run before the navigation it follows, so the requests
   * it started were counted.
   */
  async waitForIdle(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const remaining = this.binding === undefined ? 0 : this.binding.untilIdle();
      if (remaining !== undefined && remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, remaining ?? 50)));
    }
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive; reading its body waits for the load
   * to finish, and fails if the network ends first (`NetworkBinding.waitForResponse`).
   */
  waitForResponse(matches: (url: string) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const binding = this.binding;
    if (binding === undefined) return Promise.reject(new Error('waitForResponse: the network is not bound to a user context'));
    return binding.waitForResponse(matches, (context) => this.options.onPage(context), signal);
  }

  /**
   * Removes the resources of `binding` (every intercept it added, so one a
   * failed replacement left behind goes too, its collectors, and its
   * subscription) and any earlier removal that failed, every one attempted;
   * one the browser no longer has is done, any other failure is thrown so
   * the attempt's close reports it and the browser is retired rather than
   * reused with it in place.
   */
  private async release(binding: NetworkBinding | undefined): Promise<void> {
    const connection = this.connection;
    const removals = [...this.unreleased, ...(binding?.removals() ?? [])];
    const results = await Promise.allSettled(removals.map((removal) => alreadyGone(removal(), connection)));
    this.unreleased = removals.filter((_removal, index) => results[index]!.status === 'rejected');
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  /** Ends the attempt's network: listeners, pending response waits, routes, intercepts, collectors, and subscription. */
  async dispose(): Promise<void> {
    this.offClose();
    const binding = this.binding;
    this.binding = undefined;
    binding?.close();
    this.routes = [];
    await this.change(() => this.release(binding));
  }
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

/** `headers` without the site headers the driver added to a previous hop, where the hop still carries the value it added. */
function withoutInjected(headers: Record<string, string>, injected: Readonly<Record<string, string>>): Record<string, string> {
  const stale = Object.entries(injected).filter(([name, value]) => headers[name] === value);
  if (stale.length === 0) return headers;
  const kept = { ...headers };
  for (const [name] of stale) delete kept[name];
  return kept;
}

/** A header record as BiDi headers. */
function wireHeaders(headers: Readonly<Record<string, string>>): Network.Header[] {
  return Object.entries(headers).flatMap(([name, value]) => (name.toLowerCase() === 'set-cookie' ? value.split('\n') : [value]).map((one) => ({ name, value: { type: 'string' as const, value: one } })));
}

