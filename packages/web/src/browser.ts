/**
 * The `browser` fixture: the browser-shaped deterministic surface this engine
 * contributes. It lives here, not in core, because the harness knows the
 * engine contract and never a platform's fixture shape. Every async method
 * runs as a harness-recorded `browser.<method>` step; `expect(browser)` reaches the
 * matchers attached through `context.expectable`.
 *
 * Layering rule: validation (`resolveUrl`, JSON checks, cookie URLs, the
 * download trigger) runs outside `surface.guard`, so a runner error keeps its
 * classification and only Playwright faults are translated. The URL rule is
 * never re-implemented here: `context.app.resolveUrl` is the one place that
 * says which URLs a test may open.
 */

import type { Download, Response, Route } from 'playwright-core';
import type { ActionOptions, Expectable, JsonValue, Locator, Screen, TextMatch } from 'e2e';
import {
  ConfigurationError,
  Deadline,
  describePattern,
  EngineError,
  matchesText,
  pollCondition,
  raceAbort,
  rejectUnknownOptions,
  TestError,
  toTextPattern,
  urlMatches,
  validateJsonValue,
  withTimeout,
  type EngineFixtureContext,
  type FixtureOperation,
  type FixtureOperations,
  type LocatorExpression,
  type OperationContext,
  type TextPattern,
} from 'e2e/engine';
import { classifyInputError } from './actions.ts';
import type { DialogHandler } from './dialogs.ts';
import { saveDownloadsTo, saveFromBrowser, saveLocally } from './downloads.ts';
import { isTestErrorCode, message as causeMessage, translatePwError } from './support.ts';
import { compileEvaluation } from './evaluation.ts';
import { initScriptLabel, testInitScriptSource } from './init-scripts.ts';
import { lowercaseNames } from './protected-app.ts';
import { parseContinue, parseFulfill, requireNoArguments } from './route-options.ts';
import { routePatternMatches, routePatternsEqual } from './route-pattern.ts';
import type { PlaywrightSurface } from './surface.ts';

/**
 * One of `json`, `body`, or `path`, or none for an empty body. `path` names a
 * file relative to the project root; its `Content-Type` follows its
 * extension unless `contentType` or a `content-type` header sets one.
 */
export type RouteFulfillResponse = {
  status?: number;
  headers?: Record<string, string>;
  /** Sets the `Content-Type` response header. */
  contentType?: string;
} & (
  | { json: JsonValue; body?: never; path?: never }
  | { body: string; json?: never; path?: never }
  | { path: string; json?: never; body?: never }
  | { body?: never; json?: never; path?: never }
);

/** What `continue` changes about the request before it goes to the network. */
export interface RouteContinueOverrides {
  /** Resolved against the base URL like `goto`; must keep the request's scheme. */
  url?: string;
  /** Request method. */
  method?: string;
  /** Replaces every request header; the configured `headers` for the app's site are added on top. */
  headers?: Record<string, string>;
  /** Request body. */
  postData?: string;
}

export interface WebRoute {
  /** The intercepted request. */
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly postData?: string;
  };
  /** Fulfills the intercepted request once. */
  fulfill(response: RouteFulfillResponse): Promise<void>;
  /** Sends the intercepted request to the network once, skipping every other route. */
  continue(overrides?: RouteContinueOverrides): Promise<void>;
  /** Hands the intercepted request to the route registered before this one, or the network when none matches. */
  fallback(): Promise<void>;
  /** Aborts the intercepted request once. */
  abort(): Promise<void>;
}

export interface WebResponse {
  /** Response URL. */
  readonly url: string;
  /** HTTP status. */
  readonly status: number;
  /** Response headers, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Waits for the body and parses it as JSON; rejects with `ACTION_FAILED` when the body could not be read. */
  json<T = unknown>(): Promise<T>;
  /** Waits for the body and reads it as text; rejects with `ACTION_FAILED` when the body could not be read. */
  text(): Promise<string>;
}

/**
 * Reads the body once the response is known and keeps the outcome: a body
 * that arrived decodes to text on every call, a body the browser could not
 * read rejects every call with `ACTION_FAILED` naming the cause. Swallowing
 * that failure would hand the test an empty string the server never sent,
 * indistinguishable from a real empty body. The browser reports the reason
 * on the request (`net::ERR_CONTENT_LENGTH_MISMATCH` for a connection cut
 * short of the declared length, `net::ERR_ABORTED` for a request the page
 * aborted), and the protocol error behind the read is the fallback, as for a
 * redirect, whose body the browser never keeps.
 */
async function readResponseBody(response: Response): Promise<() => Promise<string>> {
  try {
    const text = new TextDecoder().decode(await response.body());
    return () => Promise.resolve(text);
  } catch (cause) {
    const reason = response.request().failure()?.errorText ?? causeMessage(cause);
    const error = new TestError(
      'ACTION_FAILED',
      `waitForResponse: response body could not be read: ${reason}`,
    );
    return () => Promise.reject(error);
  }
}

export interface CookieFields {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  /** HttpOnly flag. */
  httpOnly?: boolean;
  /** Secure flag. */
  secure?: boolean;
  /** SameSite attribute. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `url`, or `domain` with an optional `path`, never both. */
export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

export interface BrowserExpectation {
  /** Inverts the matcher. */
  readonly not: BrowserExpectation;
  /** Waits for the current URL to match; `ignoreCase` compares a string case-insensitively and adds the `i` flag to a RegExp, `false` removes it. */
  toHaveURL(expected: string | RegExp, options?: { ignoreCase?: boolean; timeout?: number }): Promise<void>;
  /** Waits for the current title to match. */
  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for the target's `class` attribute to match: a string is the whole normalized class list, a RegExp is tested against it. */
  toHaveClass(target: Locator, expected: TextMatch, options?: { timeout?: number }): Promise<void>;
}

/**
 * The screen scope `browser.frameLocator` returns. Every `Screen` query answers
 * from inside the frame, and because the frame's document is Playwright's,
 * the web-only escape hatches follow it in: `locator` for a CSS or XPath
 * selector on a control with no accessible name, `frameLocator` for a frame
 * nested inside this one.
 */
export interface FrameScreen extends Screen {
  /** Creates a web-only CSS or XPath locator inside this frame. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside an iframe nested in this frame. */
  frameLocator(selector: string): FrameScreen;
}

/**
 * The browser the attempt drives, showing one active tab. Navigation, reads,
 * `locator`, `frameLocator`, `evaluate`, `waitForResponse`, `waitForDownload`,
 * the keyboard and mouse, `expect(browser)`, and `screen` act on the active
 * tab; cookies, routes, and dialog handlers cover the whole browser, every
 * tab included. A tab the app opens itself (a `target="_blank"` link,
 * `window.open`) is not followed: the active tab stays the one the attempt
 * opened.
 */
export interface Browser extends Expectable<BrowserExpectation> {
  /** Navigates to an allowed URL. */
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeout?: number;
    },
  ): Promise<void>;
  /** Reloads the current document. */
  reload(options?: ActionOptions): Promise<void>;
  /** Navigates browser history back once. */
  back(options?: ActionOptions): Promise<void>;
  /** Navigates browser history forward once. */
  forward(options?: ActionOptions): Promise<void>;
  /** Returns the current URL. */
  url(): Promise<string>;
  /** Returns the current title. */
  title(): Promise<string>;
  /** Waits for the current URL to match. */
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** Creates a web-only CSS or XPath locator. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside one iframe. */
  frameLocator(selector: string): FrameScreen;
  /** Evaluates trusted test code in the page: a function, or a string expression whose value is returned, called first if it is a function. */
  evaluate<T extends JsonValue>(fn: string | (() => T | Promise<T>)): Promise<T>;
  /** Evaluates trusted test code with one required JSON-safe argument. */
  evaluate<T extends JsonValue, Arg extends JsonValue>(
    fn: string | ((arg: Arg) => T | Promise<T>),
    arg: Arg,
  ): Promise<T>;
  /**
   * Adds a script every document runs before the page's own, from the next
   * navigation on: JavaScript source, a `{ path }` relative to the project
   * root, or a function.
   */
  addInitScript(script: string | { path: string } | (() => unknown)): Promise<void>;
  /** Adds an init script function called with one JSON argument. */
  addInitScript<Arg extends JsonValue>(script: (arg: Arg) => unknown, arg: Arg): Promise<void>;
  /** Adds an attempt-scoped network route. */
  route(
    pattern: string | RegExp,
    handler: (route: WebRoute) => void | Promise<void>,
  ): Promise<void>;
  /** Removes matching attempt-scoped routes. */
  unroute(pattern: string | RegExp): Promise<void>;
  /** Waits for a matching response. */
  waitForResponse(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<WebResponse>;
  /** Returns cookies visible to the current context. */
  cookies(): Promise<Cookie[]>;
  /** Sets cookies after URL validation. */
  setCookies(cookies: readonly Cookie[]): Promise<void>;
  /** Sets the viewport size. */
  setViewport(size: { width: number; height: number }): Promise<void>;
  /** Registers an attempt-scoped dialog handler and returns an unsubscribe function. */
  onDialog(handler: DialogHandler): Promise<() => Promise<void>>;
  /** Runs a trigger and waits for its download. */
  waitForDownload(
    trigger: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<{ path: string; suggestedFilename: string }>;
  /** Viewport-level keyboard, for whatever has focus. */
  readonly keyboard: {
    /** Sends one key. */
    press(key: string): Promise<void>;
    /** Types plain text. */
    type(text: string): Promise<void>;
  };
  /**
   * Direct pointer input from test code, independent of agent observations.
   * After CDP recovery, test code can read current geometry with `evaluate`
   * before starting a pointer sequence.
   */
  readonly mouse: {
    /** Moves the pointer. */
    move(x: number, y: number): Promise<void>;
    /** Scrolls the pointer wheel. */
    wheel(deltaX: number, deltaY: number): Promise<void>;
    /** Presses the primary pointer button. */
    down(): Promise<void>;
    /** Releases the primary pointer button. */
    up(): Promise<void>;
  };
}

interface StoredRoute {
  readonly pattern: TextPattern;
  readonly pwHandler: (route: Route) => Promise<void>;
  readonly predicate: (url: URL) => boolean;
}

/** Builds the `browser` fixture for one attempt over the shared surface. */
export function createBrowserFixture(surface: PlaywrightSurface, context: EngineFixtureContext): Browser {
  const latch = surface.latch;
  const routes: StoredRoute[] = [];

  /**
   * Relative URLs and URL matching need the configured base. Resolving the
   * empty reference yields the base itself, and lets the harness raise
   * `APP_URL_REQUIRED` when there is none.
   */
  const baseHref = (): string => context.app.resolveUrl('');

  /**
   * A navigation's budget: the call's own timeout, else the test timeout the
   * harness gives `app.open` - a document load is not an action and must not
   * be cut at the action timeout.
   */
  const navigation = (
    options: { timeout?: number } | undefined,
    run: (operation: OperationContext) => Promise<void>,
  ): Promise<void> => {
    const operation = context.operation(options?.timeout ?? context.timeouts.test);
    return surface.guard(operation, 'navigation', run);
  };

  /** An assertion-style budget: the given timeout or the assertion timeout, clamped to the test. */
  const deadlineFor = (timeout: number | undefined): Deadline =>
    new Deadline(context.operation(timeout ?? context.timeouts.assertion).timeoutMs);

  /** The page URL, read within the action timeout or, for a matcher poll, within the poll's deadline. */
  const currentUrl = (deadline?: Deadline) =>
    surface.guard(context.operation(deadline?.remaining()), 'url', async () => surface.requirePage().url());
  /** The page title, read within the action timeout or, for a matcher poll, within the poll's deadline. */
  const currentTitle = (deadline?: Deadline) =>
    surface.guard(context.operation(deadline?.remaining()), 'title', () => surface.requirePage().title());
  const expectation = createBrowserExpectation({ currentUrl, currentTitle, baseHref, deadlineFor, context });

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    goto(url, options) {
      const resolved = context.app.resolveUrl(url);
      return navigation(options, async (operation) => {
        const page = await surface.ensurePage();
        await page.goto(resolved, {
          waitUntil: options?.waitUntil ?? 'load',
          timeout: operation.timeoutMs,
        });
      });
    },
    reload: (options) =>
      navigation(options, async (operation) => {
        await surface.requirePage().reload({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    back: (options) =>
      navigation(options, async (operation) => {
        await surface.requirePage().goBack({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    forward: (options) =>
      navigation(options, async (operation) => {
        await surface.requirePage().goForward({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    url: () => currentUrl(),
    title: () => currentTitle(),
    // The same poll as `expect(browser).toHaveURL`, exposed as a wait.
    waitForURL: (url, options) => {
      rejectUnknownOptions('browser.waitForURL', options, ['timeout']);
      return expectation.toHaveURL(url, options);
    },
    locator: (selector) => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: (selector) => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    async evaluate<T extends JsonValue>(
      fn: string | ((arg?: never) => T | Promise<T>),
      arg?: JsonValue,
    ): Promise<T> {
      const source = typeof fn === 'string' ? fn : fn.toString();
      validateJsonValue(arg, 'evaluate argument');
      const evaluate = compileEvaluation(source, arg !== undefined);
      // JSON safety is checked above; Playwright's recursive argument type cannot expand JsonValue.
      const input: unknown = arg;
      const result = await surface.guard(context.operation(), 'evaluate', () =>
        surface.requirePage().evaluate(evaluate, input),
      );
      if (!result.ok) throw new TestError('EVALUATE_FAILED', result.message);
      validateJsonValue(result.value, 'evaluate result');
      return result.value as T;
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      const source = await testInitScriptSource(script, rest.length === 0 ? undefined : { arg: rest[0] }, (file) => surface.projectPath(file));
      await surface.guard(context.operation(), 'addInitScript', () => surface.addInitScript(source));
    },
    route(pattern, handler) {
      const wirePattern = toTextPattern(pattern);
      const predicate = (url: URL) => routePatternMatches(wirePattern, url.href);
      // Playwright never surfaces a throwing route handler to the test, so a
      // contract violation (no decision, two decisions) or a failing handler
      // is latched on the surface and fails the next step with its real cause.
      const handleRoute = async (route: Route): Promise<void> => {
        let decided = false;
        const decide = (name: string) => {
          if (decided) {
            throw new TestError('ACTION_FAILED', `route handler already decided; ${name} called twice`);
          }
          decided = true;
        };
        // Validation runs before `decide`, so a rejected option leaves the
        // request to the abort below. A Playwright call that fails after the
        // decision aborts too, rather than leaving the page's request pending.
        const decideWith = async (name: string, act: () => Promise<void>): Promise<void> => {
          decide(name);
          try {
            await act();
          } catch (cause) {
            await route.abort().catch(() => undefined);
            throw cause;
          }
        };
        const request = route.request();
        const postData = request.postData();
        const publicRoute: WebRoute = {
          request: {
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            ...(postData === null ? {} : { postData }),
          },
          fulfill: async (response) => {
            const decision = parseFulfill(response, (file) => surface.projectPath(file));
            await decideWith('fulfill', () => route.fulfill({
              ...decision,
              ...(decision.json === undefined && decision.path === undefined && decision.body === undefined
                ? { body: '' }
                : {}),
            }));
          },
          continue: async (overrides) => {
            const { headers, ...decision } = parseContinue(overrides, request.url(), context.app.resolveUrl);
            // `continue` skips every route registered before this one, the
            // site-header route included, so it merges those headers itself.
            const site = surface.siteHeaders(decision.url ?? request.url());
            await decideWith('continue', () => route.continue({
              ...decision,
              ...(headers === undefined && site === undefined
                ? {}
                : { headers: { ...lowercaseNames(headers ?? request.headers()), ...site } }),
            }));
          },
          fallback: async (...args: unknown[]) => {
            requireNoArguments('route.fallback', args);
            await decideWith('fallback', () => route.fallback());
          },
          abort: async (...args: unknown[]) => {
            requireNoArguments('route.abort', args);
            await decideWith('abort', () => route.abort());
          },
        };
        try {
          await handler(publicRoute);
          if (!decided) {
            throw new TestError(
              'ACTION_FAILED',
              'route handler returned without calling fulfill, continue, fallback, or abort',
            );
          }
        } catch (cause) {
          latch.latch(
            cause instanceof Error
              ? cause
              : new TestError('ACTION_FAILED', `route handler failed: ${causeMessage(cause)}`),
          );
          if (!decided) await route.abort().catch(() => undefined);
        }
      };
      // Tracked so the attempt end waits for a handler still running and
      // collects what it latched.
      const pwHandler = (route: Route): Promise<void> => {
        const work = handleRoute(route);
        latch.track('route', work);
        return work;
      };
      return surface.guard(context.operation(), 'route', async () => {
        routes.push({ pattern: wirePattern, pwHandler, predicate });
        await surface.route(predicate, pwHandler);
      });
    },
    unroute(pattern) {
      const wirePattern = toTextPattern(pattern);
      return surface.guard(context.operation(), 'unroute', async () => {
        for (let i = routes.length - 1; i >= 0; i -= 1) {
          const stored = routes[i]!;
          if (routePatternsEqual(stored.pattern, wirePattern)) {
            await surface.unroute(stored.predicate, stored.pwHandler);
            routes.splice(i, 1);
          }
        }
      });
    },
    waitForResponse(pattern, options) {
      const wirePattern = toTextPattern(pattern);
      const operation = context.operation(options?.timeout);
      return surface.guard(operation, 'waitForResponse', async (currentOperation) => {
        const response = await surface.requirePage().waitForResponse(
          (candidate) => routePatternMatches(wirePattern, candidate.url()),
          { timeout: currentOperation.timeoutMs },
        );
        // Started now, while the browser still holds the body, and awaited
        // only by `text` and `json` on a budget of their own: the timeout
        // bounds the match, never a body still streaming in behind headers
        // that already arrived.
        const body = readResponseBody(response);
        const text = async (): Promise<string> => {
          const { signal, timeoutMs } = context.operation();
          const read = await raceAbort(
            withTimeout(body, timeoutMs, () =>
              new TestError('ACTION_FAILED', `waitForResponse: response body did not finish within ${timeoutMs}ms`)),
            signal,
            'waitForResponse body',
          );
          return read();
        };
        return {
          url: response.url(),
          status: response.status(),
          headers: response.headers(),
          json: async <T = unknown>() => JSON.parse(await text()) as T,
          text,
        };
      });
    },
    cookies: () =>
      surface.guard(context.operation(), 'cookies', async () => {
        const cookies = await surface.requireContext().cookies();
        return cookies.map(
          (cookie): Cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            ...(cookie.expires >= 0 ? { expires: Math.floor(cookie.expires) } : {}),
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
          }),
        );
      }),
    setCookies(cookies) {
      const scheme = new URL(baseHref()).protocol === 'https:' ? 'https' : 'http';
      // The harness's URL rule decides which cookie targets are admitted; a
      // domain cookie is checked as the origin it would be sent to. The rule
      // admits `about:blank` for navigation, which holds no cookie. A `url`
      // cookie is set on the URL the rule resolved, so a relative one lands
      // on the base URL the way `goto` would.
      const targets = cookies.map((cookie) => {
        const target = context.app.resolveUrl(
          cookie.url === undefined ? `${scheme}://${cookie.domain.replace(/^\./, '')}` : cookie.url,
        );
        if (!/^https?:/.test(target)) {
          throw new ConfigurationError('POLICY_DENIED', `cookie URL must be http(s): ${target}`);
        }
        return cookie.url === undefined
          ? { domain: cookie.domain, path: cookie.path ?? '/' }
          : { url: target };
      });
      return surface.guard(context.operation(), 'setCookies', async () => {
        await surface.requireContext().addCookies(
          cookies.map((cookie, index) => ({
            name: cookie.name,
            value: cookie.value,
            ...targets[index]!,
            ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
            ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
            ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
            ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
          })),
        );
      });
    },
    setViewport: (size) =>
      surface.guard(context.operation(), 'setViewport', async () => {
        await surface.setViewport(size);
        context.attachViewport({ width: size.width, height: size.height, scale: 1 });
      }),
    // Async so the harness records the registration as a `browser.onDialog` step.
    async onDialog(handler: DialogHandler) {
      const unsubscribe = surface.dialogs.add(handler);
      return async () => unsubscribe();
    },
    async waitForDownload(trigger, options) {
      const operation = context.operation(options?.timeout);
      let triggerFailure: { cause: unknown } | undefined;
      let awaiting: { waitMs: number; triggerMs: number } | undefined;
      return surface.guard(operation, 'download', async (currentOperation) => {
        const remote = surface.remoteDownloads();
        if (remote !== undefined) await saveDownloadsTo(surface.requirePage(), remote.dir);
        const waiter: Promise<Download> = surface.requirePage()
          .waitForEvent('download', { timeout: currentOperation.timeoutMs });
        // The trigger may fail before the waiter settles; absorb its later rejection.
        waiter.catch(() => undefined);
        const triggerStart = Date.now();
        try {
          await trigger();
        } catch (cause) {
          triggerFailure = { cause };
          throw cause;
        }
        awaiting = { waitMs: currentOperation.timeoutMs, triggerMs: Date.now() - triggerStart };
        const download = await waiter;
        awaiting = undefined;
        const suggestedFilename = download.suggestedFilename();
        const { relative, absolute } = surface.artifactPath('downloads', suggestedFilename, '');
        if (remote === undefined) await saveLocally(download, absolute, surface.unservedDownloads());
        else await saveFromBrowser(download, remote, absolute, currentOperation.signal);
        context.attachArtifact('download', relative);
        return { path: relative, suggestedFilename };
      }, (cause, label) => {
        // The trigger is test code, so its errors keep their original classification.
        if (triggerFailure !== undefined && Object.is(cause, triggerFailure.cause)) throw cause;
        const translated = translatePwError(cause, label);
        // The waiter's clock starts before the trigger runs, so the message names both.
        if (awaiting !== undefined && translated instanceof EngineError && translated.code === 'OPERATION_TIMEOUT') {
          return new TestError(
            'ACTION_FAILED',
            `no download started within ${awaiting.waitMs}ms; the trigger resolved after ${awaiting.triggerMs}ms`,
            { cause },
          );
        }
        return translated;
      }, 'test-code');
    },
    keyboard: {
      press: (key) =>
        surface.guard(context.operation(), 'keyboard.press', () => surface.requirePage().keyboard.press(key), classifyInputError),
      type: (text) =>
        surface.guard(context.operation(), 'keyboard.type', () => surface.requirePage().keyboard.type(text), classifyInputError),
    },
    mouse: {
      move: (x, y) =>
        surface.guard(context.operation(), 'mouse.move', () => surface.requirePage().mouse.move(x, y), classifyInputError),
      wheel: (deltaX, deltaY) =>
        surface.guard(context.operation(), 'mouse.wheel', () => surface.requirePage().mouse.wheel(deltaX, deltaY), classifyInputError),
      down: () => surface.guard(context.operation(), 'mouse.down', () => surface.requirePage().mouse.down(), classifyInputError),
      up: () => surface.guard(context.operation(), 'mouse.up', () => surface.requirePage().mouse.up(), classifyInputError),
    },
  };

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
    waitForURL: { ...navigationCall, verifies: true, label: (url) => String(url) },
    evaluate: action,
    addInitScript: { ...action, label: (script) => initScriptLabel(script) },
    route: { ...action, label: (pattern) => String(pattern) },
    unroute: { ...action, label: (pattern) => String(pattern) },
    waitForResponse: { ...action, timeout: (_pattern, options) => options?.timeout, label: (pattern) => String(pattern) },
    cookies: action,
    setCookies: action,
    setViewport: action,
    onDialog: action,
    waitForDownload: { ...action, timeout: (_trigger, options) => options?.timeout },
    keyboard: { press: { ...action, label: (key) => key }, type: { ...action, label: (text) => `${text.length} chars` } },
    mouse: { move: action, wheel: action, down: action, up: action },
  });
}

interface ExpectationDeps {
  currentUrl(deadline: Deadline): Promise<string>;
  currentTitle(deadline: Deadline): Promise<string>;
  baseHref(): string;
  deadlineFor(timeout: number | undefined): Deadline;
  readonly context: EngineFixtureContext;
}

/** One read of a browser matcher poll: whether the condition holds (undefined: not evaluable yet), and what was seen. */
interface BrowserSample {
  readonly matches: boolean | undefined;
  readonly observed: string;
}

/**
 * `expect(browser)` matchers: URL, title, and class polling against the
 * assertion budget. Every read is bounded by the poll's deadline, so a page
 * that stops answering ends the assertion at its own timeout, and the
 * failure reports the last read instead of reading a hung page again.
 */
function createBrowserExpectation(deps: ExpectationDeps, negated = false): BrowserExpectation {
  const poll = async (
    api: string,
    label: string,
    read: (deadline: Deadline) => Promise<BrowserSample>,
    timeout: number | undefined,
  ): Promise<void> => {
    const deadline = deps.deadlineFor(timeout);
    // pollCondition calls onTimeout only after a read completed, so a sample is always there.
    let last: BrowserSample | undefined;
    await pollCondition({
      deadline,
      signal: deps.context.signal,
      negated,
      evaluate: async () => {
        last = await read(deadline);
        return last.matches;
      },
      onTimeout: (cause) =>
        new TestError(
          'ASSERTION_FAILED',
          `expect.${negated ? 'not.' : ''}${api} failed\nexpected: ${negated ? 'not ' : ''}${label}\nobserved: ${last?.observed ?? 'nothing'}`,
          cause === undefined ? undefined : { cause },
        ),
    });
  };
  const validate = (api: string, options: object | undefined, keys: readonly string[] = ['timeout']): void =>
    rejectUnknownOptions(`expect.${negated ? 'not.' : ''}${api}`, options, keys);
  return {
    get not() {
      return createBrowserExpectation(deps, !negated);
    },
    toHaveURL(expected, options) {
      validate('toHaveURL', options, ['ignoreCase', 'timeout']);
      const ignoreCase = options?.ignoreCase;
      if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') {
        throw new TestError('INVALID_ARGUMENT', `expect.${negated ? 'not.' : ''}toHaveURL option ignoreCase must be a boolean`);
      }
      const label = typeof expected === 'string' ? expected : String(expected);
      const target = deps.baseHref();
      return poll(
        'toHaveURL',
        `URL ${label}${ignoreCase === true ? ' (ignoring case)' : ''}`,
        async (deadline) => {
          const url = await deps.currentUrl(deadline);
          return { matches: urlMatches(url, expected, target, ignoreCase), observed: `URL ${url}` };
        },
        options?.timeout,
      );
    },
    toHaveTitle(expected, options) {
      validate('toHaveTitle', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveTitle',
        `title ${describePattern(pattern)}`,
        async (deadline) => {
          const title = await deps.currentTitle(deadline);
          return { matches: matchesText(title, pattern), observed: `title ${JSON.stringify(title)}` };
        },
        options?.timeout,
      );
    },
    toHaveClass(target, expected, options) {
      validate('toHaveClass', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveClass',
        `class ${describePattern(pattern)}`,
        async (deadline) => {
          let value: string | null;
          try {
            // A locator read takes the action timeout; the poll's deadline is the tighter bound.
            value = await withTimeout(
              target.getAttribute('class'),
              deadline.remaining(),
              () => new EngineError('OPERATION_TIMEOUT', 'class read timed out', { retryable: false }),
            );
          } catch (error) {
            if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return { matches: undefined, observed: 'no node' };
            throw error;
          }
          if (value === null) return { matches: false, observed: 'no class attribute' };
          return {
            matches: matchesText(value.trim().split(/\s+/).join(' '), pattern),
            observed: `class ${JSON.stringify(value)}`,
          };
        },
        options?.timeout,
      );
    },
  };
}

function requireSelector(method: string, selector: unknown): string {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new TestError('INVALID_LOCATOR', `${method}() requires a nonempty selector`);
  }
  return selector;
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
