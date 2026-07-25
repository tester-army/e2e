/** Playwright-backed DriverWeb channel: navigation, routing, dialogs, downloads. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  BrowserContext,
  Dialog as PwDialog,
  Download,
  Page,
  Route,
} from 'playwright';
import {
  DriverError,
  type Cookie,
  type DriverDialog,
  type DriverWeb,
  type DriverWebResponse,
  type DriverWebRoute,
  type JsonValue,
  type OperationContext,
  type TextPattern,
} from '../driver/index.js';
import { routePatternMatches, routePatternsEqual } from '../internal/route-pattern.js';
import { invalidState, message, sanitizeFilename } from './support.js';

interface StoredRoute {
  readonly pattern: TextPattern;
  readonly pwHandler: (route: Route) => Promise<void>;
  readonly predicate: (url: URL) => boolean;
}

/** Session capabilities the web channel borrows. */
export interface WebSessionHost {
  requirePage(): Page;
  ensurePage(): Promise<Page>;
  requireContext(): BrowserContext;
  /** Checks cancellation, runs fn, and translates raw errors at the SPI boundary. */
  guard<T>(operation: OperationContext, label: string, fn: () => Promise<T>): Promise<T>;
  readonly artifactsDir: string;
}

/** Owns all web-namespace state for one driver session. */
export class WebChannel {
  private readonly routes: StoredRoute[] = [];
  private readonly dialogHandlers = new Map<
    string,
    'accept' | 'dismiss' | ((dialog: DriverDialog) => void | Promise<void>)
  >();
  private readonly downloads = new Map<string, Promise<Download>>();
  private dialogHandlerCounter = 0;
  private downloadCounter = 0;
  private latchedDialogError: DriverError | null = null;

  constructor(private readonly host: WebSessionHost) {}

  /** Rethrows an error latched by an unhandled or failing dialog handler. */
  throwPendingDialogError(): void {
    if (this.latchedDialogError !== null) {
      const error = this.latchedDialogError;
      this.latchedDialogError = null;
      throw error;
    }
  }

  /** Routes one native dialog to the newest registered handler. */
  async dispatchDialog(dialog: PwDialog): Promise<void> {
    const entries = [...this.dialogHandlers.entries()];
    const newest = entries[entries.length - 1];
    if (newest === undefined) {
      this.latchedDialogError = new DriverError(
        'INVALID_STATE',
        `unhandled ${dialog.type()} dialog: ${dialog.message()}`,
        { retryable: false },
      );
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    const handler = newest[1];
    const wireDialog: DriverDialog = {
      message: dialog.message(),
      accept: async (text) => {
        await dialog.accept(text);
      },
      dismiss: async () => {
        await dialog.dismiss();
      },
    };
    try {
      if (handler === 'accept') await dialog.accept();
      else if (handler === 'dismiss') await dialog.dismiss();
      else await handler(wireDialog);
    } catch (cause) {
      this.latchedDialogError = new DriverError(
        'DRIVER_FAILURE',
        `dialog handler failed: ${message(cause)}`,
        { retryable: false, cause },
      );
    }
  }

  readonly web: DriverWeb = {
    goto: (url, waitUntil, operation) =>
      this.host.guard(operation, 'navigation', async () => {
        const page = await this.host.ensurePage();
        await page.goto(url, { waitUntil: waitUntil ?? 'load', timeout: operation.timeoutMs });
      }),
    reload: (operation) =>
      this.host.guard(operation, 'navigation', async () => {
        await this.host.requirePage().reload({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    back: (operation) =>
      this.host.guard(operation, 'navigation', async () => {
        await this.host.requirePage().goBack({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    forward: (operation) =>
      this.host.guard(operation, 'navigation', async () => {
        await this.host.requirePage().goForward({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    url: (operation) => this.host.guard(operation, 'url', async () => this.host.requirePage().url()),
    title: (operation) => this.host.guard(operation, 'title', () => this.host.requirePage().title()),
    evaluate: <T extends JsonValue>(
      source: string,
      argument: JsonValue | undefined,
      operation: OperationContext,
    ): Promise<T> =>
      this.host.guard(operation, 'evaluate', async () => {
        const page = this.host.requirePage();
        if (argument === undefined) {
          return (await page.evaluate(`(${source})()`)) as T;
        }
        const wrapped = new Function('arg', `return (${source})(arg);`);
        const evaluate = page.evaluate.bind(page) as (fn: unknown, arg: unknown) => Promise<unknown>;
        return (await evaluate(wrapped, argument)) as T;
      }),
    route: (pattern, handler, operation) =>
      this.host.guard(operation, 'route', async () => {
        const page = this.host.requirePage();
        const predicate = (url: URL) => routePatternMatches(pattern, url.href);
        const pwHandler = async (route: Route): Promise<void> => {
          const wireRoute: DriverWebRoute = {
            request: {
              url: route.request().url(),
              method: route.request().method(),
              headers: route.request().headers(),
              ...(route.request().postData() !== null
                ? { postData: route.request().postData()! }
                : {}),
            },
            fulfill: async (response) => {
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
              await route.fallback();
            },
            abort: async () => {
              await route.abort();
            },
          };
          await handler(wireRoute);
        };
        this.routes.push({ pattern, pwHandler, predicate });
        await page.route(predicate, pwHandler);
      }),
    unroute: (pattern, operation) =>
      this.host.guard(operation, 'unroute', async () => {
        const page = this.host.requirePage();
        for (let i = this.routes.length - 1; i >= 0; i -= 1) {
          const stored = this.routes[i]!;
          if (routePatternsEqual(stored.pattern, pattern)) {
            await page.unroute(stored.predicate, stored.pwHandler);
            this.routes.splice(i, 1);
          }
        }
      }),
    waitForResponse: (pattern, operation): Promise<DriverWebResponse> =>
      this.host.guard(operation, 'waitForResponse', async () => {
        const page = this.host.requirePage();
        const response = await page.waitForResponse(
          (candidate) => routePatternMatches(pattern, candidate.url()),
          { timeout: operation.timeoutMs },
        );
        const body = await response.body().catch(() => Buffer.alloc(0));
        return {
          url: response.url(),
          status: response.status(),
          headers: response.headers(),
          body: new Uint8Array(body),
        };
      }),
    cookies: (operation) =>
      this.host.guard(operation, 'cookies', async () => {
        const cookies = await this.host.requireContext().cookies();
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
    setCookies: (cookies, operation) =>
      this.host.guard(operation, 'setCookies', async () => {
        await this.host.requireContext().addCookies(
          cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            ...(cookie.url !== undefined
              ? { url: cookie.url }
              : { domain: cookie.domain!, path: cookie.path ?? '/' }),
            ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
            ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
            ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
            ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
          })),
        );
      }),
    setViewport: (size, operation) =>
      this.host.guard(operation, 'setViewport', async () => {
        await this.host.requirePage().setViewportSize(size);
      }),
    setDialogHandler: (handler, operation) =>
      this.host.guard(operation, 'setDialogHandler', async () => {
        this.dialogHandlerCounter += 1;
        const id = `dialog-${this.dialogHandlerCounter}`;
        this.dialogHandlers.set(id, handler);
        return id;
      }),
    removeDialogHandler: (id, operation) =>
      this.host.guard(operation, 'removeDialogHandler', async () => {
        this.dialogHandlers.delete(id);
      }),
    beginDownload: (operation) =>
      this.host.guard(operation, 'download', async () => {
        const page = this.host.requirePage();
        this.downloadCounter += 1;
        const id = `download-${this.downloadCounter}`;
        this.downloads.set(id, page.waitForEvent('download', { timeout: operation.timeoutMs }));
        return id;
      }),
    finishDownload: (id, operation) =>
      this.host.guard(operation, 'download', async () => {
        const waiter = this.downloads.get(id);
        if (waiter === undefined) throw invalidState(`unknown download waiter ${id}`);
        this.downloads.delete(id);
        const download = await waiter;
        const suggestedFilename = download.suggestedFilename();
        const relative = path.posix.join('downloads', `${id}-${sanitizeFilename(suggestedFilename)}`);
        const absolute = path.join(this.host.artifactsDir, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        await download.saveAs(absolute);
        return { path: relative, suggestedFilename };
      }),
    cancelDownload: (id, operation) =>
      this.host.guard(operation, 'download', async () => {
        const waiter = this.downloads.get(id);
        this.downloads.delete(id);
        waiter?.catch(() => undefined);
      }),
    keyboardPress: (key, operation) =>
      this.host.guard(operation, 'keyboard.press', () => this.host.requirePage().keyboard.press(key)),
    keyboardType: (text, operation) =>
      this.host.guard(operation, 'keyboard.type', () => this.host.requirePage().keyboard.type(text)),
    mouseMove: (x, y, operation) =>
      this.host.guard(operation, 'mouse.move', () => this.host.requirePage().mouse.move(x, y)),
    mouseWheel: (deltaX, deltaY, operation) =>
      this.host.guard(operation, 'mouse.wheel', () =>
        this.host.requirePage().mouse.wheel(deltaX, deltaY),
      ),
    mouseDown: (operation) =>
      this.host.guard(operation, 'mouse.down', () => this.host.requirePage().mouse.down()),
    mouseUp: (operation) =>
      this.host.guard(operation, 'mouse.up', () => this.host.requirePage().mouse.up()),
  };
}
