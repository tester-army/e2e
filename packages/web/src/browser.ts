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

import type { Download, Response, Route } from 'playwright';
import type { ActionOptions, Expectable, JsonValue, Locator, Screen, TextMatch } from 'e2e';
import {
  Deadline,
  describePattern,
  EngineError,
  matchesText,
  pollCondition,
  TestError,
  toTextPattern,
  urlMatches,
  validateJsonValue,
  type EngineFixtureContext,
  type FixtureOperation,
  type FixtureOperations,
  type LocatorExpression,
  type OperationContext,
  type TextPattern,
} from 'e2e/engine';
import type { DialogHandler } from './dialogs.ts';
import { saveDownloadsTo, saveFromBrowser, saveLocally } from './downloads.ts';
import { isTestErrorCode, message as causeMessage, translatePwError } from './support.ts';
import { compileEvaluation } from './evaluation.ts';
import { routePatternMatches, routePatternsEqual } from './route-pattern.ts';
import type { PlaywrightSurface } from './surface.ts';

/** `json` or `body`, never both; neither fulfills with an empty body. */
export type RouteFulfillResponse = {
  status?: number;
  headers?: Record<string, string>;
} & (
  | { json: JsonValue; body?: never }
  | { body: string; json?: never }
  | { body?: never; json?: never }
);

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
  /** Continues the intercepted request once. */
  continue(): Promise<void>;
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
  /** Parses the response body as JSON; rejects with `ACTION_FAILED` when the body could not be read. */
  json<T = unknown>(): Promise<T>;
  /** Reads the response body as text; rejects with `ACTION_FAILED` when the body could not be read. */
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
  /** Waits for the current URL to match. */
  toHaveURL(expected: string | RegExp, options?: { timeout?: number }): Promise<void>;
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
  /** Evaluates trusted test code in the page. */
  evaluate<T extends JsonValue>(fn: string | (() => T | Promise<T>)): Promise<T>;
  /** Evaluates trusted test code with one required JSON-safe argument. */
  evaluate<T extends JsonValue, Arg extends JsonValue>(
    fn: string | ((arg: Arg) => T | Promise<T>),
    arg: Arg,
  ): Promise<T>;
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

  const currentUrl = () => surface.guard(context.operation(), 'url', async () => surface.requirePage().url());
  const currentTitle = () =>
    surface.guard(context.operation(), 'title', () => surface.requirePage().title());
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
    url: currentUrl,
    title: currentTitle,
    // The same poll as `expect(browser).toHaveURL`, exposed as a wait.
    waitForURL: (url, options) => expectation.toHaveURL(url, options),
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
        const postData = route.request().postData();
        const publicRoute: WebRoute = {
          request: {
            url: route.request().url(),
            method: route.request().method(),
            headers: route.request().headers(),
            ...(postData === null ? {} : { postData }),
          },
          fulfill: async (response) => {
            decide('fulfill');
            await route.fulfill({
              status: response.status ?? 200,
              headers: response.headers ?? {},
              ...('json' in response && response.json !== undefined
                ? { json: response.json }
                : 'body' in response && response.body !== undefined
                  ? { body: response.body }
                  : { body: '' }),
            });
          },
          continue: async () => {
            decide('continue');
            await route.fallback();
          },
          abort: async () => {
            decide('abort');
            await route.abort();
          },
        };
        try {
          await handler(publicRoute);
          if (!decided) {
            throw new TestError(
              'ACTION_FAILED',
              'route handler returned without calling fulfill, continue, or abort',
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
        const body = await readResponseBody(response);
        return {
          url: response.url(),
          status: response.status(),
          headers: response.headers(),
          json: async <T = unknown>() => JSON.parse(await body()) as T,
          text: body,
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
      // domain cookie is checked as the origin it would be sent to.
      for (const cookie of cookies) {
        context.app.resolveUrl(
          cookie.url === undefined ? `${scheme}://${cookie.domain.replace(/^\./, '')}` : cookie.url,
        );
      }
      return surface.guard(context.operation(), 'setCookies', async () => {
        await surface.requireContext().addCookies(
          cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            ...(cookie.url === undefined
              ? { domain: cookie.domain, path: cookie.path ?? '/' }
              : { url: cookie.url }),
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
      });
    },
    keyboard: {
      press: (key) =>
        surface.guard(context.operation(), 'keyboard.press', () => surface.requirePage().keyboard.press(key)),
      type: (text) =>
        surface.guard(context.operation(), 'keyboard.type', () => surface.requirePage().keyboard.type(text)),
    },
    mouse: {
      move: (x, y) =>
        surface.guard(context.operation(), 'mouse.move', () => surface.requirePage().mouse.move(x, y)),
      wheel: (deltaX, deltaY) =>
        surface.guard(context.operation(), 'mouse.wheel', () =>
          surface.requirePage().mouse.wheel(deltaX, deltaY),
        ),
      down: () => surface.guard(context.operation(), 'mouse.down', () => surface.requirePage().mouse.down()),
      up: () => surface.guard(context.operation(), 'mouse.up', () => surface.requirePage().mouse.up()),
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
  currentUrl(): Promise<string>;
  currentTitle(): Promise<string>;
  baseHref(): string;
  deadlineFor(timeout: number | undefined): Deadline;
  readonly context: EngineFixtureContext;
}

/** `expect(browser)` matchers: URL, title, and class polling against the assertion budget. */
function createBrowserExpectation(deps: ExpectationDeps, negated = false): BrowserExpectation {
  const poll = async (
    api: string,
    label: string,
    condition: () => Promise<boolean | undefined>,
    observed: () => Promise<string>,
    timeout: number | undefined,
  ): Promise<void> => {
    await pollCondition({
      deadline: deps.deadlineFor(timeout),
      signal: deps.context.signal,
      negated,
      evaluate: condition,
      onTimeout: async () =>
        new TestError(
          'ASSERTION_FAILED',
          `expect.${negated ? 'not.' : ''}${api} failed\nexpected: ${negated ? 'not ' : ''}${label}\nobserved: ${await observed()}`,
        ),
    });
  };
  return {
    get not() {
      return createBrowserExpectation(deps, !negated);
    },
    toHaveURL(expected, options) {
      const label = typeof expected === 'string' ? expected : String(expected);
      const target = deps.baseHref();
      return poll(
        'toHaveURL',
        `URL ${label}`,
        async () => urlMatches(await deps.currentUrl(), expected, target),
        async () => `URL ${await deps.currentUrl()}`,
        options?.timeout,
      );
    },
    toHaveTitle(expected, options) {
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveTitle',
        `title ${describePattern(pattern)}`,
        async () => matchesText(await deps.currentTitle(), pattern),
        async () => `title ${JSON.stringify(await deps.currentTitle())}`,
        options?.timeout,
      );
    },
    toHaveClass(target, expected, options) {
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveClass',
        `class ${describePattern(pattern)}`,
        async () => {
          try {
            const value = await target.getAttribute('class');
            if (value === null) return false;
            const normalized = value.trim().split(/\s+/).join(' ');
            return matchesText(normalized, pattern);
          } catch (error) {
            if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return undefined;
            throw error;
          }
        },
        async () => {
          try {
            const value = await target.getAttribute('class');
            if (value === null) return 'no class attribute';
            return `class ${JSON.stringify(value)}`;
          } catch (error) {
            if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return 'no node';
            throw error;
          }
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
