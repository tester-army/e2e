/**
 * The `web` fixture: the browser-shaped deterministic surface this backend
 * contributes. It lives here, not in core, because the harness knows the
 * backend contract and never a platform's fixture shape. Every async method
 * runs as a harness-recorded `web.<method>` step; `expect(web)` reaches the
 * matchers attached through `context.expectable`.
 *
 * Layering rule: policy and validation (`resolveUrl`, JSON checks, cookie
 * origins, the download trigger) run outside `surface.guard`, so a runner
 * error keeps its classification and only Playwright faults are translated.
 * The origin policy itself is never re-implemented here: `context.app.
 * resolveUrl` is the one place that says which URLs the app admits.
 */

import type { Download, Route } from 'playwright';
import type { ActionOptions, Expectable, JsonValue, Locator, Screen, TextMatch } from 'e2e';
import {
  Deadline,
  describePattern,
  matchesText,
  pollCondition,
  TestError,
  toTextPattern,
  urlMatches,
  validateJsonValue,
  type BackendFixtureContext,
  type OperationContext,
  type TextPattern,
} from 'e2e/backend';
import type { DialogHandler } from './dialogs.ts';
import { message as causeMessage } from './support.ts';
import { routePatternMatches, routePatternsEqual, toRoutePattern } from './route-pattern.ts';
import type { PlaywrightSurface } from './surface.ts';

export type RouteFulfillResponse = {
  status?: number;
  headers?: Record<string, string>;
} & (
  | { json: JsonValue; body?: never }
  | { body: string; json?: never }
  | { body?: never; json?: never }
);

export interface WebRoute {
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
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Parses the response body as JSON. */
  json<T = unknown>(): Promise<T>;
  /** Reads the response body as text. */
  text(): Promise<string>;
}

export interface CookieFields {
  name: string;
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

export interface WebExpectation {
  readonly not: WebExpectation;
  /** Waits for the current URL to match. */
  toHaveURL(expected: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** Waits for the current title to match. */
  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
}

export interface Web extends Expectable<WebExpectation> {
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
  frameLocator(selector: string): Screen;
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
  /** Sets cookies after origin policy validation. */
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
  readonly keyboard: {
    /** Sends one key. */
    press(key: string): Promise<void>;
    /** Types plain text. */
    type(text: string): Promise<void>;
  };
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

/** Builds the `web` fixture for one attempt over the shared surface. */
export function createWebFixture(surface: PlaywrightSurface, context: BackendFixtureContext): Web {
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
    return surface.guard(operation, 'navigation', () => run(operation));
  };

  /** An assertion-style budget: the given timeout or the assertion timeout, clamped to the test. */
  const deadlineFor = (timeout: number | undefined): Deadline =>
    new Deadline(context.operation(timeout ?? context.timeouts.assertion).timeoutMs);

  const currentUrl = () => surface.url(context.operation());
  const currentTitle = () =>
    surface.guard(context.operation(), 'title', () => surface.requirePage().title());
  const expectation = createWebExpectation({ currentUrl, currentTitle, baseHref, deadlineFor, context });

  const web: Omit<Web, keyof Expectable<WebExpectation>> = {
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
    // The same poll as `expect(web).toHaveURL`, exposed as a wait.
    waitForURL: (url, options) => expectation.toHaveURL(url, options),
    locator(selector) {
      if (typeof selector !== 'string' || selector.length === 0) {
        throw new TestError('INVALID_LOCATOR', 'web.locator() requires a nonempty selector');
      }
      return context.locator({ kind: 'selector', selector });
    },
    frameLocator(selector) {
      if (typeof selector !== 'string' || selector.length === 0) {
        throw new TestError('INVALID_LOCATOR', 'web.frameLocator() requires a nonempty selector');
      }
      return context.screen((expression) => ({ kind: 'frame', selector, source: expression }));
    },
    async evaluate<T extends JsonValue>(
      fn: string | ((arg?: never) => T | Promise<T>),
      arg?: JsonValue,
    ): Promise<T> {
      const source = typeof fn === 'string' ? fn : fn.toString();
      validateJsonValue(arg, 'evaluate argument');
      const result = await surface.guard(context.operation(), 'evaluate', async () => {
        const page = surface.requirePage();
        if (arg === undefined) return page.evaluate(`(${source})()`);
        const wrapped = new Function('arg', `return (${source})(arg);`);
        const evaluate = page.evaluate.bind(page) as (fn: unknown, arg: unknown) => Promise<unknown>;
        return evaluate(wrapped, arg);
      });
      validateJsonValue(result, 'evaluate result');
      return result as T;
    },
    route(pattern, handler) {
      const wirePattern = toRoutePattern(pattern);
      const predicate = (url: URL) => routePatternMatches(wirePattern, url.href);
      // Playwright never surfaces a throwing route handler to the test, so a
      // contract violation (no decision, two decisions) or a failing handler
      // is latched on the surface and fails the next step with its real cause.
      const pwHandler = async (route: Route): Promise<void> => {
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
          surface.latch.latch(
            cause instanceof Error
              ? cause
              : new TestError('ACTION_FAILED', `route handler failed: ${causeMessage(cause)}`),
          );
          if (!decided) await route.abort().catch(() => undefined);
        }
      };
      return surface.guard(context.operation(), 'route', async () => {
        routes.push({ pattern: wirePattern, pwHandler, predicate });
        await surface.requirePage().route(predicate, pwHandler);
      });
    },
    unroute(pattern) {
      const wirePattern = toRoutePattern(pattern);
      return surface.guard(context.operation(), 'unroute', async () => {
        const page = surface.requirePage();
        for (let i = routes.length - 1; i >= 0; i -= 1) {
          const stored = routes[i]!;
          if (routePatternsEqual(stored.pattern, wirePattern)) {
            await page.unroute(stored.predicate, stored.pwHandler);
            routes.splice(i, 1);
          }
        }
      });
    },
    waitForResponse(pattern, options) {
      const wirePattern = toRoutePattern(pattern);
      const operation = context.operation(options?.timeout);
      return surface.guard(operation, 'waitForResponse', async () => {
        const response = await surface.requirePage().waitForResponse(
          (candidate) => routePatternMatches(wirePattern, candidate.url()),
          { timeout: operation.timeoutMs },
        );
        const body = await response.body().catch(() => Buffer.alloc(0));
        const decoder = new TextDecoder();
        return {
          url: response.url(),
          status: response.status(),
          headers: response.headers(),
          json: async <T = unknown>() => JSON.parse(decoder.decode(body)) as T,
          text: async () => decoder.decode(body),
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
      // The harness's origin policy decides which cookie targets are admitted;
      // a domain cookie is checked as the origin it would be sent to.
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
        await surface.requirePage().setViewportSize(size);
        context.attachViewport({ width: size.width, height: size.height, scale: 1 });
      }),
    // Async so the harness records the registration as a `web.onDialog` step.
    async onDialog(handler: DialogHandler) {
      const unsubscribe = surface.dialogs.add(handler);
      return async () => unsubscribe();
    },
    async waitForDownload(trigger, options) {
      const operation = context.operation(options?.timeout);
      // The waiter is armed synchronously, before the trigger, and never
      // awaited through an async wrapper: an `async` guard would flatten the
      // returned promise and wait for the download before the trigger ran.
      const waiter: Promise<Download> = surface
        .requirePage()
        .waitForEvent('download', { timeout: operation.timeoutMs });
      // A rejected waiter nobody awaits (the trigger failed first) must not
      // become an unhandled rejection.
      waiter.catch(() => undefined);
      // The trigger is test code: its own errors keep their own classification.
      await trigger();
      return surface.guard(operation, 'download', async () => {
        const download = await waiter;
        const suggestedFilename = download.suggestedFilename();
        const { relative, absolute } = surface.artifactPath('downloads', suggestedFilename, '');
        await download.saveAs(absolute);
        context.attachArtifact('download', relative);
        return { path: relative, suggestedFilename };
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

  return context.expectable(web, () => expectation);
}

interface ExpectationDeps {
  currentUrl(): Promise<string>;
  currentTitle(): Promise<string>;
  baseHref(): string;
  deadlineFor(timeout: number | undefined): Deadline;
  readonly context: BackendFixtureContext;
}

/** `expect(web)` matchers: URL and title polling against the assertion budget. */
function createWebExpectation(deps: ExpectationDeps, negated = false): WebExpectation {
  const poll = async (
    api: string,
    label: string,
    condition: () => Promise<boolean>,
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
      return createWebExpectation(deps, !negated);
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
  };
}
