/**
 * The `browser` fixture over the driver's surface: each method's step
 * declaration, the matchers (`expectation.ts`), the route contract
 * (`routes.ts`), and the argument checks (`arguments.ts`). Every async
 * method runs as a harness-recorded `browser.<method>` step;
 * `expect(browser)` reaches the matchers attached through
 * `context.expectable`.
 *
 * Layering rule: validation (`resolveUrl`, JSON checks, cookie URLs, the
 * download trigger) runs outside the surface's guard, so a runner error
 * keeps its classification and only driver faults are translated. The URL
 * rule is never re-implemented here: `context.app.resolveUrl` is the one
 * place that says which URLs a test may open.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { Expectable, JsonValue } from 'e2e';
import {
  Deadline,
  rejectUnknownOptions,
  stepTimeout,
  TestError,
  toTextPattern,
  type EngineFixtureContext,
  type FixtureOperation,
  type FixtureOperations,
  type LocatorExpression,
  type OperationContext,
} from 'e2e/engine';
import { createBrowserExpectation } from './expectation.ts';
import type { Browser, BrowserExpectation, Cookie, FrameScreen, WebResponse } from './types.ts';
import { initScriptLabel, testInitScriptSource } from '../init-scripts.ts';
import { mediaLabel } from '../options.ts';
import { evaluateInPage } from '../in-page/evaluation.ts';
import { routePatternMatches, routePatternsEqual } from '../driver/route-pattern.ts';
import { cookieTargets, requireCookieFilter, requireDownloadCount, requireMedia } from './arguments.ts';
import { moveSources, pressDownSources, releaseSources, wheelSources } from '../driver/input-sources.ts';
import type { InterceptedRequest } from '../driver/network.ts';
import { readResponseBody, runRouteHandler, waitedResponse, webResponse } from './routes.ts';
import type { AttemptScope, BidiSurface } from '../driver/surface.ts';
import type { PageArgument } from '../driver/script.ts';

/** Builds the attempt's `browser` fixture over the driver's surface. */
export function createBrowserFixture(surface: BidiSurface, context: EngineFixtureContext): Browser {
  const navigation = (api: string, options: { timeout?: number } | undefined): OperationContext =>
    context.operation(stepTimeout(options?.timeout, api) ?? context.timeouts.test);
  const currentUrl = (deadline?: Deadline): Promise<string> => surface.url(context.operation(deadline?.remaining()));
  const currentTitle = (deadline?: Deadline): Promise<string> => surface.title(context.operation(deadline?.remaining()));
  const expectation = createBrowserExpectation({
    currentUrl,
    currentTitle,
    // An app without a URL has no site either.
    baseHref: () => (context.app.site === undefined ? undefined : context.app.resolveUrl('')),
    deadlineFor: (timeout, api) => new Deadline(context.operation(stepTimeout(timeout, api) ?? context.timeouts.assertion).timeoutMs),
    context,
  });
  const scope = surface.attemptScope();
  const { latch } = scope;

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    goto: (url, options) => surface.goto(context.app.resolveUrl(url), options?.waitUntil ?? 'load', navigation('browser.goto', options)),
    reload: (options) => surface.reload(navigation('browser.reload', options)),
    back: (options) => surface.back(navigation('browser.back', options)),
    forward: (options) => surface.forward(navigation('browser.forward', options)),
    url: () => currentUrl(),
    title: () => currentTitle(),
    waitForURL: (url, options) => {
      rejectUnknownOptions('browser.waitForURL', options, ['timeout']);
      return expectation.toHaveURL(url, options);
    },
    locator: (selector) => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: (selector) => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    evaluate<T extends JsonValue>(fn: string | ((arg?: never) => T | Promise<T>), arg?: JsonValue): Promise<T> {
      return evaluateInPage(fn, arg, (evaluate, input) => surface.evaluate(evaluate.toString(), input as PageArgument | undefined, context.operation()));
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      const source = await testInitScriptSource(script, rest.length === 0 ? undefined : { arg: rest[0] }, (file) => surface.projectPath(file));
      await surface.addInitScript(source, context.operation());
    },
    route(pattern, handler) {
      return surface.route({
        pattern: toTextPattern(pattern),
        handle: (request, decisions) => {
          const work = runRouteHandler(
            handler,
            { url: request.url, method: request.method, headers: request.headers, ...(request.postData === undefined ? {} : { postData: request.postData }) },
            { ...decisions, fetch: () => routeFetch(surface, scope, context, request) },
            (error) => latch.latch(error),
            context,
            (file) => surface.projectPath(file),
          );
          latch.track('route', work);
          return work;
        },
      }, context.operation());
    },
    unroute(pattern) {
      const wirePattern = toTextPattern(pattern);
      return surface.unroute((route) => routePatternsEqual(route.pattern, wirePattern), context.operation());
    },
    unrouteAll: () => surface.unroute(() => true, context.operation()),
    async waitForResponse(pattern, options) {
      const wirePattern = toTextPattern(pattern);
      const response = await surface.waitForResponse((url) => routePatternMatches(wirePattern, url), context.operation(stepTimeout(options?.timeout, 'browser.waitForResponse')));
      return waitedResponse(context, response, readResponseBody('waitForResponse', () => response.body()));
    },
    cookies: async () => (await surface.cookies(context.operation())).map(toCookie),
    setCookies(cookies) {
      const targets = cookieTargets(cookies, context);
      const partial = cookies.map((cookie, index): Storage.PartialCookie => {
        const target = targets[index]!;
        const url = 'url' in target ? new URL(target.url) : undefined;
        return {
          name: cookie.name,
          value: { type: 'string', value: cookie.value },
          domain: url?.hostname ?? ('domain' in target ? target.domain : ''),
          path: url === undefined ? ('path' in target ? target.path : '/') : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1),
          ...(cookie.expires !== undefined && cookie.expires >= 0 ? { expiry: Math.floor(cookie.expires) } : {}),
          ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
          secure: cookie.secure ?? url?.protocol === 'https:',
          ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite.toLowerCase() as Network.SameSite } : {}),
        };
      });
      return surface.setCookies(partial, context.operation());
    },
    async clearCookies(options) {
      requireCookieFilter(options);
      const fields = ['name', 'domain', 'path'] as const;
      const operation = context.operation();
      if (fields.every((field) => typeof options?.[field] !== 'object')) {
        const filter = Object.fromEntries(fields.flatMap((field) => (options?.[field] === undefined ? [] : [[field, options[field]]])));
        return surface.deleteCookies([filter], operation);
      }
      const matches = (await surface.cookies(operation)).filter((cookie) =>
        fields.every((field) => {
          const wanted = options?.[field];
          return wanted === undefined || (typeof wanted === 'string' ? cookie[field] === wanted : new RegExp(wanted.source, wanted.flags).test(cookie[field]));
        }),
      );
      return surface.deleteCookies(matches.map(({ name, domain, path }) => ({ name, domain, path })), operation);
    },
    setViewport: async (size) => {
      await surface.setViewport(size, context.operation());
      context.attachViewport({ width: size.width, height: size.height, scale: 1 });
    },
    emulateMedia: (media) => surface.emulateMedia(requireMedia(media), context.operation()),
    // Async so the harness records the registration as a `browser.onDialog` step.
    async onDialog(handler) {
      const unsubscribe = surface.onDialog(handler);
      return async () => unsubscribe();
    },
    async waitForDownload(trigger, options) {
      const [file] = await downloads(surface, context, trigger, 1, options?.timeout, 'browser.waitForDownload');
      return file!;
    },
    waitForDownloads: (trigger, options) => downloads(surface, context, trigger, requireDownloadCount(options), options.timeout, 'browser.waitForDownloads'),
    keyboard: {
      down: (key) => surface.keyboard('keyboard.down', key, 'keyDown', context.operation()),
      up: (key) => surface.keyboard('keyboard.up', key, 'keyUp', context.operation()),
      press: (key) => surface.keyboard('keyboard.press', key, 'press', context.operation()),
      type: (text) => surface.typeKeys(text, context.operation()),
    },
    mouse: {
      move: (x, y) => surface.input('mouse.move', moveSources(Math.round(x), Math.round(y)), context.operation()),
      wheel: (deltaX, deltaY) => {
        const at = surface.pointerPosition();
        return surface.input('mouse.wheel', wheelSources(at.x, at.y, deltaX, deltaY), context.operation());
      },
      down: () => {
        const at = surface.pointerPosition();
        return surface.input('mouse.down', pressDownSources(at.x, at.y), context.operation());
      },
      up: () => surface.input('mouse.up', releaseSources(), context.operation()),
    },
  };
  return declareFixture(context, browser, expectation);
}

/**
 * Declares a built `browser` object as the fixture: each method's step kind,
 * label, and timeout, and `expect(browser)` wired to `expectation`.
 */
function declareFixture(
  context: EngineFixtureContext,
  browser: Omit<Browser, keyof Expectable<BrowserExpectation>>,
  expectation: BrowserExpectation,
): Browser {
  const action: FixtureOperation = { kind: 'resource' };
  const navigationCall = { kind: 'resource', timeout: false } as const;
  const matchers: FixtureOperations<BrowserExpectation> = {
    toHaveURL: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveTitle: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveClass: { kind: 'assertion', timeout: false, label: (_target, expected) => String(expected) },
    get not() { return matchers; },
  };
  return context.fixture('browser', context.expectable(browser, () => context.fixture('expect', expectation, matchers)), {
    goto: { ...navigationCall, label: (url) => url },
    reload: navigationCall,
    back: navigationCall,
    forward: navigationCall,
    url: action,
    title: action,
    waitForURL: { ...navigationCall, verifies: true, label: patternLabel },
    evaluate: action,
    addInitScript: { ...action, label: (script) => initScriptLabel(script) },
    route: { ...action, label: patternLabel },
    unroute: { ...action, label: patternLabel },
    unrouteAll: action,
    waitForResponse: { ...action, timeout: (_pattern, options) => options?.timeout, label: patternLabel },
    cookies: action,
    setCookies: action,
    clearCookies: action,
    setViewport: action,
    emulateMedia: { ...action, label: (media) => mediaLabel(media) },
    onDialog: action,
    waitForDownload: { ...action, timeout: false },
    waitForDownloads: { ...action, timeout: false },
    keyboard: { down: { ...action, label: (key) => key }, up: { ...action, label: (key) => key }, press: { ...action, label: (key) => key }, type: { ...action, label: (text) => `${text.length} chars` } },
    mouse: { move: action, wheel: action, down: action, up: action },
  });
}

/**
 * `route.fetch` for a request held in the attempt `scope`: replays it from
 * Node as the browser sent it (its body bytes, its cookies, and the site
 * headers) within the operation's budget, and stores the cookies the
 * response sets in the user context, as Playwright's `route.fetch` does. A
 * Basic challenge is answered once with the attempt's `basicAuth`
 * credentials, as the browser answers its own. A body the browser did not
 * keep refuses the replay rather than send none.
 */
async function routeFetch(surface: BidiSurface, scope: AttemptScope, context: EngineFixtureContext, request: InterceptedRequest): Promise<WebResponse> {
  if (request.bodyUnavailable === true) {
    throw new TestError('ACTION_FAILED', 'route.fetch: the browser kept none of the request body (too large or streamed), so the request cannot be replayed');
  }
  const operation = context.operation();
  const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(operation.timeoutMs), scope.lifetime]);
  const headers = { ...request.headers, ...(request.cookie === undefined ? {} : { cookie: request.cookie }), ...surface.siteHeaders(request.url) };
  const send = (extra: Record<string, string>): Promise<Response> => fetch(request.url, {
    method: request.method,
    headers: { ...headers, ...extra },
    redirect: 'manual',
    signal,
    ...(request.body === undefined ? {} : { body: new Uint8Array(request.body) }),
  });
  let fetched = await send({});
  const { credentials } = scope;
  if (fetched.status === 401 && credentials !== undefined && /^basic\b/i.test(fetched.headers.get('www-authenticate') ?? '')) {
    await fetched.body?.cancel();
    fetched = await send({ authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` });
  }
  const cookies = fetched.headers.getSetCookie().flatMap((header) => setCookieOf(header, new URL(request.url)) ?? []);
  if (cookies.length > 0) await scope.storeCookies(cookies, signal);
  const body = await readResponseBody('route.fetch', async () => Buffer.from(await fetched.arrayBuffer()));
  const responseHeaders = Object.fromEntries([...fetched.headers].filter(([name]) => name !== 'set-cookie'));
  const setCookies = fetched.headers.getSetCookie();
  return webResponse({ url: request.url, status: fetched.status, headers: setCookies.length === 0 ? responseHeaders : { ...responseHeaders, 'set-cookie': setCookies.join('\n') } }, body);
}

/** A `Set-Cookie` cookie's path when the header gives none: the directory of `url`'s path (RFC 6265 default-path). */
function defaultCookiePath(url: URL): string {
  const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/'));
  return directory === '' ? '/' : directory;
}

/**
 * One `Set-Cookie` header of a response from `url` as a cookie to store;
 * undefined for one with no name, or with a `Domain` the response's host does
 * not belong to, which a browser would refuse too.
 */
export function setCookieOf(header: string, url: URL): Storage.PartialCookie | undefined {
  const [pair = '', ...attributes] = header.split(';');
  const split = pair.indexOf('=');
  const name = pair.slice(0, split).trim();
  if (split <= 0 || name === '') return undefined;
  const attribute = new Map<string, string>();
  for (const each of attributes) {
    const at = each.indexOf('=');
    attribute.set((at === -1 ? each : each.slice(0, at)).trim().toLowerCase(), at === -1 ? '' : each.slice(at + 1).trim());
  }
  const domain = (attribute.get('domain') ?? '').toLowerCase();
  const bare = domain.replace(/^\./, '');
  if (bare !== '' && url.hostname !== bare && !url.hostname.endsWith(`.${bare}`)) return undefined;
  const path = attribute.get('path') ?? '';
  const sameSite = attribute.get('samesite')?.toLowerCase() ?? '';
  const maxAge = attribute.get('max-age') ?? '';
  const expires = Date.parse(attribute.get('expires') ?? '');
  const expiry = /^-?\d+$/.test(maxAge) ? Math.floor(Date.now() / 1000) + Number(maxAge) : Number.isNaN(expires) ? undefined : Math.floor(expires / 1000);
  return {
    name,
    value: { type: 'string', value: pair.slice(split + 1).trim() },
    domain: domain === '' ? url.hostname : domain,
    path: path.startsWith('/') ? path : defaultCookiePath(url),
    ...(attribute.has('secure') ? { secure: true } : {}),
    ...(attribute.has('httponly') ? { httpOnly: true } : {}),
    ...(['strict', 'lax', 'none'].includes(sameSite) ? { sameSite: sameSite as Network.SameSite } : {}),
    ...(expiry === undefined ? {} : { expiry }),
  };
}

/** Runs `trigger` once and saves the first `count` downloads it starts, each attached as a `download` artifact. */
async function downloads(
  surface: BidiSurface,
  context: EngineFixtureContext,
  trigger: () => Promise<void>,
  count: number,
  timeout: number | undefined,
  api: string,
): Promise<{ path: string; absolutePath: string; suggestedFilename: string }[]> {
  const { signal, timeoutMs } = context.operation(stepTimeout(timeout, api));
  const files = await surface.collectDownloads(count, trigger, signal, timeoutMs);
  for (const file of files) context.attachArtifact('download', file.path);
  return files;
}

/** A BiDi cookie as the fixture reports it. */
function toCookie(cookie: Network.Cookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value.type === 'string' ? cookie.value.value : Buffer.from(cookie.value.value, 'base64').toString(),
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expiry === undefined ? {} : { expires: cookie.expiry }),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite === 'default' ? {} : { sameSite: (cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)) as NonNullable<Cookie['sameSite']> }),
  };
}

/** The selector a locator method was given, refused unless it is a nonempty string. */
function requireSelector(method: string, selector: unknown): string {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new TestError('INVALID_LOCATOR', `${method}() requires a nonempty selector`);
  }
  return selector;
}

/** A URL pattern as steps and errors name it: a string quoted, a RegExp as its literal. */
function patternLabel(pattern: string | RegExp): string {
  return typeof pattern === 'string' ? JSON.stringify(pattern) : String(pattern);
}

/**
 * The scope for the innermost of `frames` (outermost first). Every query and
 * both escape hatches compile through the same `frame` chain, so a `locator`
 * inside it resolves against the innermost document.
 */
function frameScreen(context: EngineFixtureContext, frames: readonly string[]): FrameScreen {
  const scope = (expression: LocatorExpression): LocatorExpression =>
    frames.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), expression);
  return Object.assign(context.screen(scope), {
    locator: (selector: string) =>
      context.locator(scope({ kind: 'selector', selector: requireSelector('locator', selector) })),
    frameLocator: (selector: string) =>
      frameScreen(context, [...frames, requireSelector('frameLocator', selector)]),
  });
}
