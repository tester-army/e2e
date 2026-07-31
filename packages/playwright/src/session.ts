/** Playwright-backed driver-1 session. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, ElementHandle, JSHandle, Page } from 'playwright';
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
  type ObserveOptions,
  type OperationContext,
  type SemanticNode,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
} from 'e2e/driver';
import { matchesText, withTimeout } from 'e2e/internal';
import { frameSelectors, projectExpression } from './locators.ts';
import { capturePixels, type PixelCapture } from './observe.ts';
import {
  readSemanticsFunction,
  SECURE_FIELD_SELECTOR,
  type RawNodeData,
  type RawObservedNode,
} from './read-node.ts';
import {
  asActionable,
  DEFAULT_VIEWPORT,
  invalidState,
  isPwTimeout,
  message,
  navigationStaleOr,
  performElementSwipe,
  performViewportSwipe,
  sanitizeFilename,
  staleOr,
  translatePwError,
  performPointerDrag,
  type ActionTarget,
} from './support.ts';
import { WebChannel, type WebSessionHost } from './web.ts';

/** Locator refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_STORED_REFS = 2048;

/**
 * Safety valve on nodes in one observation. driver-1 has no way to report a
 * truncated tree, so this must stay well above real pages and let the runner's
 * observation byte budget — which is visible in the prompt and the report —
 * be the effective limit.
 */
const MAX_OBSERVED_NODES = 3_000;

/** Nested iframe capture depth; deeper frames stay boundary nodes. */
const MAX_FRAME_DEPTH = 4;

/**
 * Budget for capturing one child document. A stalled frame (ads, trackers)
 * must cost an observation a moment, not the context default timeout.
 */
const FRAME_CAPTURE_TIMEOUT_MS = 3_000;

/** Budget for capturing the main document, still capped by the operation timeout. */
const DOCUMENT_CAPTURE_TIMEOUT_MS = 15_000;

/** Bounded settle before an observation so a committing navigation is not raced. */
const SETTLE_TIMEOUT_MS = 5_000;

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
  readonly target: ActionTarget;
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
  /** Locator-backed refs from `screen.resolve`; they hold no live handles. */
  private readonly refs = new Map<string, StoredRef>();
  /**
   * Handle-backed refs of the newest observation. One observation is one
   * handle generation: the whole map is swapped atomically per `observe()`,
   * and the superseded generation is disposed in one sweep. Keeping these out
   * of `refs` means locator-ref eviction can never destroy a handle an
   * in-flight observation still references.
   */
  private observationRefs = new Map<string, StoredRef>();
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

  /**
   * Checks cancellation, runs fn, and translates raw errors at the SPI
   * boundary. `translate` overrides the default translation for operations
   * with a documented retryable failure mode.
   */
  async guard<T>(
    operation: OperationContext,
    label: string,
    fn: () => Promise<T>,
    translate: (cause: unknown, label: string) => DriverError = translatePwError,
  ): Promise<T> {
    this.checkOperation(operation);
    try {
      return await fn();
    } catch (cause) {
      throw translate(cause, label);
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

  private storeRef(target: ActionTarget, revision: string): NodeRef {
    this.refCounter += 1;
    const id = `n${this.refCounter}`;
    this.refs.set(id, { target, revision });
    for (const oldest of this.refs.keys()) {
      if (this.refs.size <= MAX_STORED_REFS) break;
      this.refs.delete(oldest);
    }
    return { id, revision };
  }

  /** Stores one element-backed ref in the observation generation being built. */
  private storeObservationRef(
    generation: Map<string, StoredRef>,
    element: ElementHandle<Element>,
    revision: string,
  ): NodeRef {
    this.refCounter += 1;
    const id = `n${this.refCounter}`;
    generation.set(id, { target: { kind: 'element', element }, revision });
    return { id, revision };
  }

  /** Disposes every element handle in one observation generation. */
  private static disposeGeneration(generation: ReadonlyMap<string, StoredRef>): void {
    for (const stored of generation.values()) {
      if (stored.target.kind === 'element') {
        void stored.target.element.dispose().catch(() => undefined);
      }
    }
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
          refs.push(this.storeRef({ kind: 'locator', locator: nth }, revision));
        }
        return refs;
      }),

    read: async (ref, operation) => {
      this.checkOperation(operation);
      this.requirePage();
      const stored = this.lookupRef(ref);
      const args = {
        testIdAttribute: this.driverContext.app.testIdAttribute,
        secureFieldSelector: SECURE_FIELD_SELECTOR,
        mode: { kind: 'node' as const },
      };
      try {
        // A locator waits for its element to resolve; a handle-backed target
        // is already resolved, so it evaluates immediately.
        const read = readSemanticsFunction<{ kind: 'node' }>;
        const raw =
          stored.target.kind === 'locator'
            ? await stored.target.locator.evaluate(read, args, {
                timeout: Math.min(operation.timeoutMs, 5000),
              })
            : await stored.target.element.evaluate(read, args);
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
        await this.dispatchAction(stored.target, action, timeout);
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
    const stored = this.refs.get(ref.id) ?? this.observationRefs.get(ref.id);
    if (stored === undefined || stored.revision !== ref.revision) {
      throw new DriverError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    }
    return stored;
  }

  private async dispatchAction(
    target: ActionTarget,
    action: LocatorAction,
    timeout: number,
  ): Promise<void> {
    const locator = asActionable(target);
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
        await locator.fill('', { timeout });
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
        // ElementHandle.focus takes no timeout: the element is already resolved.
        if (target.kind === 'locator') await target.locator.focus({ timeout });
        else await target.element.focus();
        return;
      case 'hover':
        await locator.hover({ timeout });
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
      case 'setInputFiles':
        await locator.setInputFiles([...action.paths], { timeout });
        return;
      case 'dragTo': {
        const other = this.lookupRef(action.target);
        // Playwright's own drag when both sides are locators: it waits for
        // actionability on each and reports better failures than a pointer
        // sequence can. Anything else — an observed reference on either side —
        // is dragged with the pointer.
        if (target.kind === 'locator' && other.target.kind === 'locator') {
          await target.locator.dragTo(other.target.locator, { timeout });
        } else {
          await performPointerDrag(target, other.target, timeout);
        }
        return;
      }
      case 'swipe': {
        await performElementSwipe(target, action.direction, action.momentum ?? 'none', timeout);
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
    if (/not an? <?(input|checkbox|radio|select)|not editable|not checkable/i.test(text)) {
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
        await performElementSwipe(
          stored.target,
          direction,
          options.momentum ?? 'none',
          operation.timeoutMs,
        );
        return;
      }
      const page = this.requirePage();
      await performViewportSwipe(page, direction, options.momentum ?? 'none');
    },
    press: async (key, operation) => {
      this.checkOperation(operation);
      await this.requirePage().keyboard.press(key);
    },
    tapPoint: (point, operation) =>
      this.guard(operation, 'tapPoint', async () => {
        // The runner validated the point against the observation viewport, so
        // there is no node to check for actionability: the click is the action.
        await this.requirePage().mouse.click(point.x, point.y);
      }),
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

  /**
   * Captures one atomic semantic observation. Secure fields are masked in the
   * page before the tree leaves the backend, and every node keeps a live
   * element handle valid only for the returned revision.
   *
   * With `options.pixels`, masked viewport pixels are captured alongside the
   * tree rather than after it, so the image and the node geometry describe the
   * page as closely in time as two backend calls can.
   */
  async observe(operation: OperationContext, options?: ObserveOptions): Promise<Observation> {
    // A capture that lost its document to a navigation reads as a stale node:
    // nothing was dispatched, so the runner re-observes the new document
    // within the same deadline instead of failing the call.
    return this.guard(
      operation,
      'observe',
      () => this.captureObservation(operation, options),
      navigationStaleOr,
    );
  }

  /** One observation capture attempt, unclassified. */
  private async captureObservation(
    operation: OperationContext,
    options: ObserveOptions | undefined,
  ): Promise<Observation> {
    const page = this.requirePage();
    // A preceding action may still be committing a navigation. Settling is
    // bounded and best-effort: a slow document never fails the observation.
    await page
      .waitForLoadState('domcontentloaded', {
        timeout: Math.min(operation.timeoutMs, SETTLE_TIMEOUT_MS),
      })
      .catch(() => undefined);
    const revision = this.nextRevision();
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const generation = new Map<string, StoredRef>();
    // The screenshot masks by sweeping the page's frames, so it needs nothing
    // from the tree walk and runs with it instead of after it. Pixels never
    // fail an observation: an image the page could not produce in time gives
    // a tree-only observation, exactly like a driver that has no pixels.
    const pixelCapture =
      options?.pixels === true
        ? capturePixels(page, operation, viewport).catch(() => undefined)
        : Promise.resolve(undefined);
    let captured: Awaited<ReturnType<PlaywrightSession['captureDocument']>>;
    let capturedPixels: PixelCapture | undefined;
    try {
      // Both halves are awaited before the generation swap, so a failed
      // observation leaves the session on its previous generation instead of
      // publishing handles for a revision no caller ever received.
      [captured, capturedPixels] = await Promise.all([
        this.captureDocument(
          page.locator(':root'),
          revision,
          [],
          MAX_OBSERVED_NODES,
          generation,
          Math.max(1, Math.min(operation.timeoutMs, DOCUMENT_CAPTURE_TIMEOUT_MS)),
        ),
        pixelCapture,
      ]);
    } catch (cause) {
      PlaywrightSession.disposeGeneration(generation);
      throw cause;
    }
    PlaywrightSession.disposeGeneration(this.observationRefs);
    this.observationRefs = generation;
    return {
      revision,
      capturedAt: new Date().toISOString(),
      ...(capturedPixels === undefined ? {} : { pixels: capturedPixels.pixels }),
      tree: captured.tree,
      viewport: { width: viewport.width, height: viewport.height, scale: 1 },
      redaction: {
        secureNodeCount: captured.secureNodeCount,
        maskedRegionCount: capturedPixels?.maskedRegionCount ?? 0,
        complete: true,
      },
    };
  }

  /**
   * Captures one document's semantic tree, then descends into each observed
   * iframe boundary node via its content frame and stitches the child
   * document under it. Frame capture is best-effort: a detached or unloaded
   * frame leaves its boundary node childless rather than failing the
   * observation. The node budget is shared across all documents.
   */
  private async captureDocument(
    root: ReturnType<Page['locator']>,
    revision: string,
    framePath: readonly string[],
    budget: number,
    generation: Map<string, StoredRef>,
    timeoutMs: number,
  ): Promise<{ tree: SemanticNode; nodeCount: number; secureNodeCount: number }> {
    const evaluation = root.evaluateHandle(readSemanticsFunction, {
      testIdAttribute: this.driverContext.app.testIdAttribute,
      secureFieldSelector: SECURE_FIELD_SELECTOR,
      mode: {
        kind: 'tree' as const,
        maxNodes: budget,
        nameLimit: OBSERVED_NAME_LIMIT,
        textLimit: OBSERVED_TEXT_LIMIT,
      },
    });
    const captured = await withTimeout(evaluation, timeoutMs, () => {
      // The losing evaluation may still settle later; a late handle must be
      // released and a late failure must not become an unhandled rejection.
      void evaluation.then((handle) => handle.dispose()).catch(() => undefined);
      // Retryability is closed to NODE_STALE and FRAME_NOT_FOUND (spec
      // 09-drivers.md), so asking for a retryable timeout here silently
      // downgraded the code to DRIVER_FAILURE — reporting a broken backend for
      // a capture that merely outlived the budget it was handed.
      return new DriverError('OPERATION_TIMEOUT', 'observation capture timed out', {
        retryable: false,
      });
    });
    let elementsHandle: JSHandle | undefined;
    try {
      const [nodes, elementsProperty, initialSecureCount] = await Promise.all([
        captured.getProperty('nodes').then((handle) => handle.jsonValue()),
        captured.getProperty('elements'),
        captured.getProperty('secureNodeCount').then((handle) => handle.jsonValue()),
      ]);
      elementsHandle = elementsProperty;
      let secureNodeCount = initialSecureCount;
      const elements = await collectElementHandles(elementsHandle, nodes.length);
      const refs = elements.map((element) =>
        this.storeObservationRef(generation, element, revision),
      );
      let nodeCount = nodes.length;
      const frameChildren = new Map<number, SemanticNode>();
      if (framePath.length < MAX_FRAME_DEPTH) {
        for (let index = 0; index < nodes.length; index += 1) {
          const selector = nodes[index]!.frameSelector;
          if (selector === undefined) continue;
          const remaining = budget - nodeCount;
          if (remaining <= 0) break;
          const frame = await elements[index]!.contentFrame().catch(() => null);
          if (frame === null) continue;
          // Only frames within allowedOrigins enter observations. Third-party
          // frames (ads, trackers, embeds) are not the agent's to read or act
          // on — and a stalled ad frame must not tax the capture. They stay
          // boundary nodes, exactly like frames past the depth limit.
          if (!isAllowedFrameOrigin(frame.url(), this.driverContext.app.allowedOrigins)) continue;
          const child = await this.captureDocument(
            frame.locator(':root'),
            revision,
            [...framePath, selector],
            remaining,
            generation,
            FRAME_CAPTURE_TIMEOUT_MS,
          ).catch(() => undefined);
          if (child === undefined) continue;
          frameChildren.set(index, child.tree);
          nodeCount += child.nodeCount;
          secureNodeCount += child.secureNodeCount;
        }
      }
      return {
        tree: assembleTree(nodes, refs, framePath, frameChildren),
        nodeCount,
        secureNodeCount,
      };
    } finally {
      await elementsHandle?.dispose().catch(() => undefined);
      await captured.dispose().catch(() => undefined);
    }
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
    PlaywrightSession.disposeGeneration(this.observationRefs);
    this.observationRefs.clear();
    this.refs.clear();
  }
}

/**
 * True when a frame document's origin is inside the app's allowed origins.
 *
 * `about:blank` and `srcdoc` documents inherit their parent's origin, so they
 * are the app's own content (consent managers, editors) and always allowed; the
 * parent frame was already admitted to be captured at all.
 *
 * A `data:` document is *not* admitted, even though its bytes are written by the
 * page that embeds it. It has an opaque origin rather than an inherited one, and
 * 14-security.md denies the scheme by name alongside `file:` and `javascript:`.
 * Admitting it would be a change to that contract, not an implementation detail,
 * so a control inside an inline frame stays reachable deterministically and
 * outside the agent's view.
 */
function isAllowedFrameOrigin(url: string, allowedOrigins: readonly string[]): boolean {
  if (url === '' || url === 'about:blank' || url === 'about:srcdoc') return true;
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * Reads one element handle per observed node from the in-page element array.
 * `asElement` types handles as `ElementHandle<Node>`, but the observation walk
 * records `Element` nodes only, so the narrowing is safe by construction.
 */
async function collectElementHandles(
  elementsHandle: JSHandle,
  count: number,
): Promise<ElementHandle<Element>[]> {
  const properties = await elementsHandle.getProperties();
  const elements: ElementHandle<Element>[] = [];
  for (let index = 0; index < count; index += 1) {
    const property = properties.get(String(index));
    const element = (property?.asElement() ?? null) as ElementHandle<Element> | null;
    if (element === null) {
      // The in-page array outlived its document (a navigation committed while
      // the handles were being read back). The capture is repeatable.
      throw new DriverError('NODE_STALE', `observation node ${index} lost its element`, {
        retryable: true,
      });
    }
    elements.push(element);
  }
  for (const [key, handle] of properties) {
    if (Number(key) >= count) void handle.dispose().catch(() => undefined);
  }
  return elements;
}

/**
 * Rebuilds the observation tree from the depth-first node list. Descendants
 * always follow their parent, so children are complete before a parent is
 * built. Captured child documents attach under their iframe boundary nodes.
 */
function assembleTree(
  nodes: readonly RawObservedNode[],
  refs: readonly NodeRef[],
  framePath: readonly string[] = [],
  frameChildren: ReadonlyMap<number, SemanticNode> = new Map(),
): SemanticNode {
  if (nodes.length === 0 || refs.length === 0) {
    // An empty document is what a navigation in flight looks like; a real page
    // always has nodes, so the capture is worth repeating.
    throw new DriverError('NODE_STALE', 'observation produced no nodes', { retryable: true });
  }
  const childLists: SemanticNode[][] = nodes.map(() => []);
  const built: SemanticNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const raw = nodes[index]!;
    const embedded = frameChildren.get(index);
    if (embedded !== undefined) childLists[index]!.unshift(embedded);
    const node = toSemanticNode(refs[index]!, raw, childLists[index]!, framePath);
    built[index] = node;
    if (raw.parent >= 0) childLists[raw.parent]!.unshift(node);
  }
  return built[0]!;
}

function toSemanticNode(
  ref: NodeRef,
  raw: RawNodeData,
  children: readonly SemanticNode[] = [],
  framePath: readonly string[] = [],
): SemanticNode {
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
    ...(raw.selector === '' ? {} : { selector: raw.selector }),
    ...(framePath.length > 0 ? { framePath } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}
