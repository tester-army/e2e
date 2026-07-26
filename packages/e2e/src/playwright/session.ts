/** Playwright-backed driver-1 session. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Locator as PwLocator, Page } from 'playwright';
import {
  DriverError,
  type CleanupContext,
  type DriverAgentActions,
  type DriverApp,
  type DriverArtifacts,
  type DriverContext,
  type DriverRuntime,
  type DriverScreen,
  type DriverSession,
  type DriverState,
  type DriverWeb,
  type JsonValue,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type Observation,
  type OperationContext,
  type SemanticNode,
} from '../driver/index.ts';
import { matchesText } from '../internal/text.ts';
import { frameSelectors, projectExpression } from './locators.ts';
import { readNodeFunction, type RawNodeData } from './read-node.ts';
import {
  DEFAULT_VIEWPORT,
  invalidState,
  isPwTimeout,
  message,
  performElementSwipe,
  performViewportSwipe,
  sanitizeFilename,
  staleOr,
  translatePwError,
} from './support.ts';
import { WebChannel, type WebSessionHost } from './web.ts';

/** Refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_STORED_REFS = 2048;

interface ParsedWebTarget {
  readonly browser: 'chromium' | 'firefox' | 'webkit';
  readonly viewport: { readonly width: number; readonly height: number } | undefined;
}

/** Narrows the wire target to the web fields this driver understands. */
export function parseWebTarget(target: DriverContext['target']): ParsedWebTarget {
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

export class PlaywrightSession implements DriverSession, WebSessionHost {
  readonly artifactsDir: string;
  readonly web: DriverWeb;

  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private closed = false;
  private revisionCounter = 0;
  private refCounter = 0;
  private artifactCounter = 0;
  private tracing = false;
  private readonly refs = new Map<string, StoredRef>();
  private pendingState: DriverState | null = null;
  private readonly target: ParsedWebTarget;
  private readonly webChannel: WebChannel;

  /** The browser process is pool-owned and shared; the session owns its context. */
  constructor(
    private readonly driverContext: DriverContext,
    private readonly browser: Browser,
  ) {
    this.target = parseWebTarget(driverContext.target);
    this.artifactsDir = driverContext.artifactsDir;
    this.webChannel = new WebChannel(this);
    this.web = this.webChannel.web;
  }

  async launch(): Promise<void> {
    try {
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
    this.context = await this.browser.newContext({
      viewport: this.target.viewport ?? DEFAULT_VIEWPORT,
      acceptDownloads: true,
      ...(this.pendingState !== null
        ? { storageState: this.pendingState.data as unknown as string }
        : {}),
    });
    this.context.setDefaultTimeout(30_000);
    this.context.on('dialog', (dialog) => {
      void this.webChannel.dispatchDialog(dialog);
    });
  }

  private async rollback(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // rollback is best-effort
    }
    this.context = null;
    this.page = null;
  }

  requirePage(): Page {
    this.webChannel.throwPendingDialogError();
    if (this.page === null || this.page.isClosed()) {
      throw invalidState('no app page is open; call app.open() or web.goto() first');
    }
    return this.page;
  }

  requireContext(): BrowserContext {
    if (this.context === null) throw invalidState('session is closed');
    return this.context;
  }

  private checkOperation(operation: OperationContext): void {
    if (operation.signal.aborted) {
      throw new DriverError('CANCELLED', 'operation cancelled', { retryable: false });
    }
  }

  /** Checks cancellation, runs fn, and translates raw errors at the SPI boundary. */
  async guard<T>(operation: OperationContext, label: string, fn: () => Promise<T>): Promise<T> {
    this.checkOperation(operation);
    try {
      return await fn();
    } catch (cause) {
      throw translatePwError(cause, label);
    }
  }

  async ensurePage(): Promise<Page> {
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

  private storeRef(locator: PwLocator, revision: string): NodeRef {
    this.refCounter += 1;
    const id = `n${this.refCounter}`;
    this.refs.set(id, { locator, revision });
    for (const oldest of this.refs.keys()) {
      if (this.refs.size <= MAX_STORED_REFS) break;
      this.refs.delete(oldest);
    }
    return { id, revision };
  }

  // --- DriverApp ---

  readonly app: DriverApp = {
    open: (openPath, operation) =>
      this.guard(operation, 'navigation', async () => {
        const url = new URL(openPath ?? '', this.driverContext.app.baseUrl).href;
        const page = await this.ensurePage();
        await page.goto(url, { waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    restart: (operation) =>
      this.guard(operation, 'navigation', async () => {
        const context = this.requireContext();
        for (const page of context.pages()) await page.close();
        this.page = null;
        const page = await this.ensurePage();
        await page.goto(this.driverContext.app.baseUrl, {
          waitUntil: 'load',
          timeout: operation.timeoutMs,
        });
      }),
    clearState: (operation) =>
      this.guard(operation, 'navigation', async () => {
        const context = this.requireContext();
        await context.close();
        this.context = null;
        this.page = null;
        this.pendingState = null;
        await this.createContext();
        const page = await this.ensurePage();
        await page.goto(this.driverContext.app.baseUrl, {
          waitUntil: 'load',
          timeout: operation.timeoutMs,
        });
      }),
    back: (operation) =>
      this.guard(operation, 'navigation', async () => {
        await this.requirePage().goBack({ waitUntil: 'load', timeout: operation.timeoutMs });
      }),
    deepLink: (url, operation) =>
      this.guard(operation, 'navigation', async () => {
        const page = await this.ensurePage();
        await page.goto(url, { waitUntil: 'load', timeout: operation.timeoutMs });
      }),
  };

  // --- DriverScreen ---

  readonly screen: DriverScreen = {
    resolve: (expression, operation) =>
      this.guard(operation, 'resolve', async () => {
        const page = this.requirePage();
        await this.validateFrames(expression);
        const projected = projectExpression(page, expression);
        const revision = this.nextRevision();
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
          refs.push(this.storeRef(nth, revision));
        }
        return refs;
      }),

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

  private async validateFrames(expression: LocatorExpression): Promise<void> {
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

  // --- Artifacts ---

  readonly artifacts: DriverArtifacts = {
    screenshot: (label, operation) =>
      this.guard(operation, 'screenshot', async () => {
        const page = this.requirePage();
        this.artifactCounter += 1;
        const name = `${String(this.artifactCounter).padStart(3, '0')}${
          label === undefined ? '' : `-${sanitizeFilename(label)}`
        }.png`;
        const relative = path.posix.join('screenshots', name);
        const absolute = path.join(this.artifactsDir, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        await page.screenshot({ path: absolute, timeout: operation.timeoutMs });
        return relative;
      }),
    startTrace: (operation) =>
      this.guard(operation, 'trace', async () => {
        const context = this.requireContext();
        await context.tracing.start({ screenshots: true, snapshots: true });
        this.tracing = true;
      }),
    stopTrace: (operation) =>
      this.guard(operation, 'trace', async () => {
        const context = this.requireContext();
        const relative = path.posix.join('trace', 'trace.zip');
        const absolute = path.join(this.artifactsDir, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        await context.tracing.stop({ path: absolute });
        this.tracing = false;
        return relative;
      }),
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
    if (this.closed) throw invalidState('session is closed');
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
    this.context = null;
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
