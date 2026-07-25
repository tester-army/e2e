/** Playwright-backed driver-1 session. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  Browser,
  BrowserContext,
  Download,
  Locator as PwLocator,
  Page,
  Route,
} from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import {
  DriverError,
  type CleanupContext,
  type Cookie,
  type DriverAgentActions,
  type DriverApp,
  type DriverArtifacts,
  type DriverContext,
  type DriverDialog,
  type DriverRuntime,
  type DriverScreen,
  type DriverSession,
  type DriverState,
  type DriverWeb,
  type DriverWebResponse,
  type DriverWebRoute,
  type JsonValue,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type Observation,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
  type TextPattern,
} from '../driver/index.js';
import { routePatternMatches, routePatternsEqual } from '../internal/route-pattern.js';
import { matchesText } from '../internal/text.js';
import { frameSelectors, projectExpression } from './locators.js';
import { readNodeFunction, type RawNodeData } from './read-node.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

interface ParsedWebTarget {
  readonly browser: 'chromium' | 'firefox' | 'webkit';
  readonly viewport: { readonly width: number; readonly height: number } | undefined;
}

/** Narrows the wire target to the web fields this driver understands. */
function parseWebTarget(target: DriverContext['target']): ParsedWebTarget {
  const browser =
    'browser' in target &&
    (target.browser === 'chromium' || target.browser === 'firefox' || target.browser === 'webkit')
      ? target.browser
      : 'chromium';
  const viewport = 'viewport' in target ? target.viewport : undefined;
  return { browser, viewport };
}

interface StoredRef {
  readonly locator: PwLocator;
  readonly revision: string;
}

interface StoredRoute {
  readonly pattern: TextPattern;
  readonly pwHandler: (route: Route) => Promise<void>;
  readonly predicate: (url: URL) => boolean;
}

export class PlaywrightSession implements DriverSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private closed = false;
  private revisionCounter = 0;
  private refCounter = 0;
  private artifactCounter = 0;
  private downloadCounter = 0;
  private dialogHandlerCounter = 0;
  private tracing = false;
  private readonly refs = new Map<string, StoredRef>();
  private readonly routes: StoredRoute[] = [];
  private readonly dialogHandlers = new Map<
    string,
    'accept' | 'dismiss' | ((dialog: DriverDialog) => void | Promise<void>)
  >();
  private readonly downloads = new Map<string, Promise<Download>>();
  private latchedDialogError: DriverError | null = null;
  private pendingState: DriverState | null = null;
  private readonly target: ParsedWebTarget;

  constructor(private readonly driverContext: DriverContext) {
    this.target = parseWebTarget(driverContext.target);
  }

  async launch(): Promise<void> {
    const browserType =
      this.target.browser === 'firefox' ? firefox : this.target.browser === 'webkit' ? webkit : chromium;
    try {
      this.browser = await browserType.launch({
        headless: !this.driverContext.launchOptions.headed,
        timeout: this.driverContext.operation.timeoutMs,
      });
      await this.createContext();
    } catch (cause) {
      await this.rollback();
      throw new DriverError('DRIVER_FAILURE', `browser launch failed: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
  }

  private async createContext(): Promise<void> {
    if (this.browser === null) throw invalidState('browser is not launched');
    this.context = await this.browser.newContext({
      viewport: this.target.viewport ?? DEFAULT_VIEWPORT,
      acceptDownloads: true,
      ...(this.pendingState !== null
        ? { storageState: this.pendingState.data as unknown as string }
        : {}),
    });
    this.context.setDefaultTimeout(30_000);
    this.context.on('dialog', (dialog) => {
      void this.dispatchDialog(dialog);
    });
  }

  private async rollback(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // rollback is best-effort
    }
    try {
      await this.browser?.close();
    } catch {
      // rollback is best-effort
    }
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  private requirePage(): Page {
    this.checkLatchedDialog();
    if (this.page === null || this.page.isClosed()) {
      throw invalidState('no app page is open; call app.open() or web.goto() first');
    }
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (this.context === null) throw invalidState('session is closed');
    return this.context;
  }

  private checkLatchedDialog(): void {
    if (this.latchedDialogError !== null) {
      const error = this.latchedDialogError;
      this.latchedDialogError = null;
      throw error;
    }
  }

  private checkOperation(operation: OperationContext): void {
    if (operation.signal.aborted) {
      throw new DriverError('CANCELLED', 'operation cancelled', { retryable: false });
    }
  }

  private async ensurePage(): Promise<Page> {
    const context = this.requireContext();
    if (this.page === null || this.page.isClosed()) {
      this.page = await context.newPage();
      this.page.on('crash', () => {
        // Surfaced as a failure by the next operation on the crashed page.
      });
    }
    return this.page;
  }

  private nextRevision(): string {
    this.revisionCounter += 1;
    return `r${this.revisionCounter}`;
  }

  // --- DriverApp ---

  readonly app: DriverApp = {
    open: async (openPath, operation) => {
      this.checkOperation(operation);
      const url = new URL(openPath ?? '', this.driverContext.app.baseUrl).href;
      const page = await this.ensurePage();
      await this.guardNavigation(() =>
        page.goto(url, { waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    restart: async (operation) => {
      this.checkOperation(operation);
      const context = this.requireContext();
      for (const page of context.pages()) await page.close();
      this.page = null;
      const page = await this.ensurePage();
      await this.guardNavigation(() =>
        page.goto(this.driverContext.app.baseUrl, { waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    clearState: async (operation) => {
      this.checkOperation(operation);
      const context = this.requireContext();
      await context.close();
      this.context = null;
      this.page = null;
      this.pendingState = null;
      await this.createContext();
      const page = await this.ensurePage();
      await this.guardNavigation(() =>
        page.goto(this.driverContext.app.baseUrl, { waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    back: async (operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
      await this.guardNavigation(() =>
        page.goBack({ waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    deepLink: async (url, operation) => {
      this.checkOperation(operation);
      const page = await this.ensurePage();
      await this.guardNavigation(() =>
        page.goto(url, { waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
  };

  private async guardNavigation<T>(navigate: () => Promise<T>): Promise<T> {
    try {
      return await navigate();
    } catch (cause) {
      throw translatePwError(cause, 'navigation');
    }
  }

  // --- DriverScreen ---

  readonly screen: DriverScreen = {
    resolve: async (expression, operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
      await this.validateFrames(expression, operation);
      const projected = projectExpression(page, expression);
      const revision = this.nextRevision();
      try {
        const count = await projected.locator.count();
        const refs: NodeRef[] = [];
        for (let i = 0; i < count; i += 1) {
          const nth = count === 1 ? projected.locator : projected.locator.nth(i);
          if (projected.displayValue !== null) {
            const value = await nth
              .inputValue({ timeout: 1000 })
              .catch(() => nth.evaluate((el) => (el as HTMLInputElement).value ?? ''));
            if (!matchesText(value, projected.displayValue)) continue;
          }
          this.refCounter += 1;
          const id = `n${this.refCounter}`;
          this.refs.set(id, { locator: nth, revision });
          refs.push({ id, revision });
        }
        return refs;
      } catch (cause) {
        throw translatePwError(cause, 'resolve');
      }
    },

    read: async (ref, operation) => {
      this.checkOperation(operation);
      this.requirePage();
      const stored = this.lookupRef(ref);
      try {
        const raw = (await stored.locator.evaluate(readNodeFunction, this.driverContext.app.testIdAttribute, {
          timeout: Math.min(operation.timeoutMs, 5000),
        })) as RawNodeData;
        return toSemanticNode(ref, raw);
      } catch (cause) {
        throw staleOr(cause, 'read');
      }
    },

    perform: async (ref, action, operation) => {
      this.checkOperation(operation);
      this.requirePage();
      const stored = this.lookupRef(ref);
      const timeout = operation.timeoutMs;
      try {
        await this.dispatchAction(stored.locator, action, timeout);
      } catch (cause) {
        throw this.classifyActionError(cause, action);
      }
    },

    swipe: async (direction, momentum, operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
      await performViewportSwipe(page, direction, momentum ?? 'none');
    },
  };

  private async validateFrames(
    expression: LocatorExpression,
    operation: OperationContext,
  ): Promise<void> {
    const page = this.requirePage();
    for (const selector of frameSelectors(expression)) {
      let count: number;
      try {
        count = await page.locator(selector).count();
      } catch (cause) {
        throw translatePwError(cause, 'frame resolution');
      }
      if (count === 0) {
        throw new DriverError('FRAME_NOT_FOUND', `no frame matches ${selector}`, {
          retryable: true,
        });
      }
      if (count > 1) {
        throw new DriverError('FRAME_AMBIGUOUS', `${count} frames match ${selector}`, {
          retryable: false,
        });
      }
      void operation;
    }
  }

  private lookupRef(ref: NodeRef): StoredRef {
    const stored = this.refs.get(ref.id);
    if (stored === undefined || stored.revision !== ref.revision) {
      throw new DriverError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    }
    return stored;
  }

  private async dispatchAction(
    locator: PwLocator,
    action: LocatorAction,
    timeout: number,
  ): Promise<void> {
    switch (action.kind) {
      case 'tap':
        await locator.click({ timeout });
        return;
      case 'doubleTap':
        await locator.dblclick({ timeout });
        return;
      case 'longPress':
        await locator.click({ timeout, delay: action.durationMs ?? 500 });
        return;
      case 'fill':
        await locator.fill(action.value, { timeout });
        return;
      case 'clear':
        await locator.clear({ timeout });
        return;
      case 'press':
        await locator.press(action.key, { timeout });
        return;
      case 'check':
        await locator.check({ timeout });
        return;
      case 'uncheck':
        await locator.uncheck({ timeout });
        return;
      case 'focus':
        await locator.focus({ timeout });
        return;
      case 'scrollIntoView':
        await locator.scrollIntoViewIfNeeded({ timeout });
        return;
      case 'selectOption': {
        const value = action.value;
        if (typeof value === 'string') {
          await locator.selectOption({ label: value }, { timeout });
        } else if (value.index !== undefined) {
          await locator.selectOption({ index: value.index }, { timeout });
        } else {
          await locator.selectOption({ label: value.label }, { timeout });
        }
        return;
      }
      case 'dragTo': {
        const target = this.lookupRef(action.target);
        await locator.dragTo(target.locator, { timeout });
        return;
      }
      case 'swipe': {
        await performElementSwipe(locator, action.direction, action.momentum ?? 'none', timeout);
        return;
      }
    }
  }

  private classifyActionError(cause: unknown, action: LocatorAction): DriverError {
    if (cause instanceof DriverError) return cause;
    const text = message(cause);
    if (/strict mode violation/i.test(text)) {
      return new DriverError('DRIVER_FAILURE', text, { retryable: false, cause });
    }
    if (/element (is |was )?(detached|not attached)/i.test(text)) {
      return new DriverError('NODE_STALE', text, { retryable: true, cause });
    }
    if (/Timeout .*exceeded/i.test(text) || isPwTimeout(cause)) {
      return new DriverError(
        'NOT_ACTIONABLE',
        `${action.kind} did not become actionable in time: ${text}`,
        { retryable: false, cause },
      );
    }
    if (/not an? (input|checkbox|radio|select)|not editable|not checkable/i.test(text)) {
      return new DriverError('NOT_ACTIONABLE', text, { retryable: false, cause });
    }
    return new DriverError('DRIVER_FAILURE', text, { retryable: false, cause });
  }

  // --- DriverAgentActions ---

  readonly actions: DriverAgentActions = {
    tap: async (target, operation) => {
      await this.screen.perform(target.ref, { kind: 'tap' }, operation);
    },
    longPress: async (target, durationMs, operation) => {
      await this.screen.perform(
        target.ref,
        { kind: 'longPress', ...(durationMs !== undefined ? { durationMs } : {}) },
        operation,
      );
    },
    type: async (target, value, sensitive, operation) => {
      await this.screen.perform(target.ref, { kind: 'fill', value, sensitive }, operation);
    },
    scroll: async (direction, options, operation) => {
      this.checkOperation(operation);
      if (options.target !== undefined) {
        const stored = this.lookupRef(options.target);
        await performElementSwipe(stored.locator, direction, options.momentum ?? 'none', operation.timeoutMs);
        return;
      }
      const page = this.requirePage();
      await performViewportSwipe(page, direction, options.momentum ?? 'none');
    },
    press: async (key, operation) => {
      this.checkOperation(operation);
      await this.requirePage().keyboard.press(key);
    },
  };

  // --- DriverWeb ---

  readonly web: DriverWeb = {
    goto: async (url, waitUntil, operation) => {
      this.checkOperation(operation);
      const page = await this.ensurePage();
      await this.guardNavigation(() =>
        page.goto(url, { waitUntil: waitUntil ?? 'load', timeout: operation.timeoutMs }),
      );
    },
    reload: async (operation) => {
      this.checkOperation(operation);
      await this.guardNavigation(() =>
        this.requirePage().reload({ waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    back: async (operation) => {
      this.checkOperation(operation);
      await this.guardNavigation(() =>
        this.requirePage().goBack({ waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    forward: async (operation) => {
      this.checkOperation(operation);
      await this.guardNavigation(() =>
        this.requirePage().goForward({ waitUntil: 'load', timeout: operation.timeoutMs }),
      );
    },
    url: async (operation) => {
      this.checkOperation(operation);
      return this.requirePage().url();
    },
    title: async (operation) => {
      this.checkOperation(operation);
      return this.requirePage().title();
    },
    evaluate: async <T extends JsonValue>(
      source: string,
      argument: JsonValue | undefined,
      operation: OperationContext,
    ): Promise<T> => {
      this.checkOperation(operation);
      const page = this.requirePage();
      try {
        if (argument === undefined) {
          return (await page.evaluate(`(${source})()`)) as T;
        }
        const wrapped = new Function('arg', `return (${source})(arg);`);
        const evaluate = page.evaluate.bind(page) as (
          fn: unknown,
          arg: unknown,
        ) => Promise<unknown>;
        return (await evaluate(wrapped, argument)) as T;
      } catch (cause) {
        throw translatePwError(cause, 'evaluate');
      }
    },
    route: async (pattern, handler, operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
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
    },
    unroute: async (pattern, operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
      for (let i = this.routes.length - 1; i >= 0; i -= 1) {
        const stored = this.routes[i]!;
        if (routePatternsEqual(stored.pattern, pattern)) {
          await page.unroute(stored.predicate, stored.pwHandler);
          this.routes.splice(i, 1);
        }
      }
    },
    waitForResponse: async (pattern, operation): Promise<DriverWebResponse> => {
      this.checkOperation(operation);
      const page = this.requirePage();
      try {
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
      } catch (cause) {
        throw translatePwError(cause, 'waitForResponse');
      }
    },
    cookies: async (operation) => {
      this.checkOperation(operation);
      const cookies = await this.requireContext().cookies();
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
    },
    setCookies: async (cookies, operation) => {
      this.checkOperation(operation);
      await this.requireContext().addCookies(
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
    },
    setViewport: async (size, operation) => {
      this.checkOperation(operation);
      await this.requirePage().setViewportSize(size);
    },
    setDialogHandler: async (handler, operation) => {
      this.checkOperation(operation);
      this.dialogHandlerCounter += 1;
      const id = `dialog-${this.dialogHandlerCounter}`;
      this.dialogHandlers.set(id, handler);
      return id;
    },
    removeDialogHandler: async (id, operation) => {
      this.checkOperation(operation);
      this.dialogHandlers.delete(id);
    },
    beginDownload: async (operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
      this.downloadCounter += 1;
      const id = `download-${this.downloadCounter}`;
      this.downloads.set(id, page.waitForEvent('download', { timeout: operation.timeoutMs }));
      return id;
    },
    finishDownload: async (id, operation) => {
      this.checkOperation(operation);
      const waiter = this.downloads.get(id);
      if (waiter === undefined) throw invalidState(`unknown download waiter ${id}`);
      this.downloads.delete(id);
      try {
        const download = await waiter;
        const suggestedFilename = download.suggestedFilename();
        const relative = path.posix.join('downloads', `${id}-${sanitizeFilename(suggestedFilename)}`);
        const absolute = path.join(this.driverContext.artifactsDir, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        await download.saveAs(absolute);
        return { path: relative, suggestedFilename };
      } catch (cause) {
        throw translatePwError(cause, 'download');
      }
    },
    cancelDownload: async (id, operation) => {
      this.checkOperation(operation);
      const waiter = this.downloads.get(id);
      this.downloads.delete(id);
      waiter?.catch(() => undefined);
    },
    keyboardPress: async (key, operation) => {
      this.checkOperation(operation);
      await this.requirePage().keyboard.press(key);
    },
    keyboardType: async (text, operation) => {
      this.checkOperation(operation);
      await this.requirePage().keyboard.type(text);
    },
    mouseMove: async (x, y, operation) => {
      this.checkOperation(operation);
      await this.requirePage().mouse.move(x, y);
    },
    mouseWheel: async (deltaX, deltaY, operation) => {
      this.checkOperation(operation);
      await this.requirePage().mouse.wheel(deltaX, deltaY);
    },
    mouseDown: async (operation) => {
      this.checkOperation(operation);
      await this.requirePage().mouse.down();
    },
    mouseUp: async (operation) => {
      this.checkOperation(operation);
      await this.requirePage().mouse.up();
    },
  };

  private async dispatchDialog(dialog: import('playwright').Dialog): Promise<void> {
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

  // --- Artifacts ---

  readonly artifacts: DriverArtifacts = {
    screenshot: async (label, operation) => {
      this.checkOperation(operation);
      const page = this.requirePage();
      this.artifactCounter += 1;
      const name = `${String(this.artifactCounter).padStart(3, '0')}${
        label === undefined ? '' : `-${sanitizeFilename(label)}`
      }.png`;
      const relative = path.posix.join('screenshots', name);
      const absolute = path.join(this.driverContext.artifactsDir, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      await page.screenshot({ path: absolute, timeout: operation.timeoutMs });
      return relative;
    },
    startTrace: async (operation) => {
      this.checkOperation(operation);
      const context = this.requireContext();
      await context.tracing.start({ screenshots: true, snapshots: true });
      this.tracing = true;
    },
    stopTrace: async (operation) => {
      this.checkOperation(operation);
      const context = this.requireContext();
      const relative = path.posix.join('trace', 'trace.zip');
      const absolute = path.join(this.driverContext.artifactsDir, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      await context.tracing.stop({ path: absolute });
      this.tracing = false;
      return relative;
    },
  };

  // --- State ---

  async captureState(operation: OperationContext): Promise<DriverState> {
    this.checkOperation(operation);
    const context = this.requireContext();
    const storageState = await context.storageState({ indexedDB: true });
    return {
      format: 'playwright-storage-state',
      version: 1,
      data: storageState as unknown as JsonValue,
    };
  }

  async restoreState(state: DriverState, operation: OperationContext): Promise<void> {
    this.checkOperation(operation);
    if (state.format !== 'playwright-storage-state' || state.version !== 1) {
      throw new DriverError('INVALID_STATE', `unsupported state format ${state.format}@${state.version}`, {
        retryable: false,
      });
    }
    const context = this.requireContext();
    await context.close();
    this.context = null;
    this.page = null;
    this.pendingState = state;
    await this.createContext();
    this.pendingState = null;
  }

  // --- Observation ---

  async observe(operation: OperationContext): Promise<Observation> {
    this.checkOperation(operation);
    const page = this.requirePage();
    const revision = this.nextRevision();
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const secureCount = await page.locator('input[type="password"]').count();
    const root: SemanticNode = {
      ref: { id: 'root', revision },
      role: 'document',
    };
    return {
      revision,
      capturedAt: new Date().toISOString(),
      tree: root,
      viewport: { width: viewport.width, height: viewport.height, scale: 1 },
      redaction: {
        secureNodeCount: secureCount,
        maskedRegionCount: 0,
        complete: secureCount === 0,
      },
    };
  }

  async runtime(operation: OperationContext): Promise<DriverRuntime> {
    this.checkOperation(operation);
    if (this.browser === null) throw invalidState('session is closed');
    const viewport = this.page?.viewportSize() ?? this.target.viewport ?? DEFAULT_VIEWPORT;
    return {
      browser: {
        name: this.target.browser,
        version: this.browser.version(),
      },
      viewport: { width: viewport.width, height: viewport.height, scale: 1 },
    };
  }

  async close(context: CleanupContext): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    void context;
    if (this.tracing && this.context !== null) {
      await this.context.tracing.stop().catch(() => undefined);
    }
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    this.page = null;
    this.refs.clear();
  }
}

function toSemanticNode(ref: NodeRef, raw: RawNodeData): SemanticNode {
  const states: Record<string, boolean> = {};
  if (raw.states.checked !== null) states['checked'] = raw.states.checked;
  if (raw.states.disabled) states['disabled'] = true;
  if (raw.states.selected !== null) states['selected'] = raw.states.selected;
  if (raw.states.expanded !== null) states['expanded'] = raw.states.expanded;
  if (raw.states.focused) states['focused'] = true;
  if (raw.states.hidden) states['hidden'] = true;
  if (raw.states.secure) states['secure'] = true;
  return {
    ref,
    ...(raw.role !== null ? { role: raw.role } : {}),
    ...(raw.name !== null ? { name: raw.name } : {}),
    ...(raw.text !== null ? { text: raw.text } : {}),
    ...(raw.value !== null ? { value: raw.value } : {}),
    inputPurpose: raw.inputPurpose,
    states,
    attributes: raw.attributes,
    rect: raw.rect,
  };
}

function performViewportSwipe(
  page: Page,
  direction: ScrollDirection,
  momentum: Momentum,
): Promise<void> {
  const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
  const distance = swipeDistance(
    direction === 'up' || direction === 'down' ? viewport.height : viewport.width,
    momentum,
  );
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  return page.mouse.wheel(deltaX, deltaY);
}

async function performElementSwipe(
  locator: PwLocator,
  direction: ScrollDirection,
  momentum: Momentum,
  timeout: number,
): Promise<void> {
  const box = await locator.boundingBox({ timeout });
  if (box === null) {
    throw new DriverError('NOT_ACTIONABLE', 'element has no visible bounding box', {
      retryable: false,
    });
  }
  const distance = swipeDistance(
    direction === 'up' || direction === 'down' ? box.height : box.width,
    momentum,
  );
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  await locator.hover({ timeout });
  await locator.page().mouse.wheel(deltaX, deltaY);
}

function swipeDistance(extent: number, momentum: Momentum): number {
  const ratio = momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5;
  return Math.round(extent * ratio);
}

function wheelDelta(direction: ScrollDirection, distance: number): [number, number] {
  switch (direction) {
    case 'down':
      return [0, distance];
    case 'up':
      return [0, -distance];
    case 'right':
      return [distance, 0];
    case 'left':
      return [-distance, 0];
  }
}

function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._\-]/g, '_').slice(0, 64) || 'artifact';
}

function invalidState(text: string): DriverError {
  return new DriverError('INVALID_STATE', text, { retryable: false });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isPwTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'TimeoutError';
}

function translatePwError(cause: unknown, operation: string): DriverError {
  if (cause instanceof DriverError) return cause;
  if (isPwTimeout(cause)) {
    return new DriverError('OPERATION_TIMEOUT', `${operation} timed out: ${message(cause)}`, {
      retryable: false,
      cause,
    });
  }
  return new DriverError('DRIVER_FAILURE', `${operation} failed: ${message(cause)}`, {
    retryable: false,
    cause,
  });
}

function staleOr(cause: unknown, operation: string): DriverError {
  const text = message(cause);
  if (/detached|not attached|resolved to hidden|no element|not found/i.test(text) || isPwTimeout(cause)) {
    return new DriverError('NODE_STALE', `${operation}: ${text}`, { retryable: true, cause });
  }
  return translatePwError(cause, operation);
}
