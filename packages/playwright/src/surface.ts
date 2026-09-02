/**
 * The Playwright surface: one browser per worker, one browser context per
 * attempt, and the page every backend member delegates to. This is the closure
 * state behind `playwright()`; the backend hooks in `backend.ts` and the `web`
 * fixture in `web.ts` are thin delegates onto it. Action dispatch lives in
 * `actions.ts` and tree capture in `observation.ts`; this file owns lifecycle,
 * location, navigation, artifacts, and state.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, ElementHandle, Page } from 'playwright';
import {
  BackendError,
  type BackendAppInfo,
  type BackendAttemptContext,
  type BackendInitInfo,
  type BackendObserveOptions,
  type BackendSnapshot,
  type BackendState,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
} from 'e2e/backend';
import { matchesText } from 'e2e/internal';
import { classifyActionError, dispatchLocatorAction } from './actions.ts';
import { BrowserPool, type BrowserName } from './browser-pool.ts';
import { DialogRouter } from './dialogs.ts';
import { ensureBrowsersInstalled } from './install.ts';
import { frameSelectors, projectExpression } from './locators.ts';
import { captureDocument, toSemanticNode } from './observation.ts';
import { capturePixels, type PixelCapture } from './observe.ts';
import { readManySemanticsFunction, SECURE_FIELD_SELECTOR } from './read-node.ts';
import {
  DEFAULT_VIEWPORT,
  invalidState,
  message,
  navigationStaleOr,
  performElementSwipe,
  performViewportSwipe,
  sanitizeFilename,
  staleOr,
  translatePwError,
  type ActionTarget,
} from './support.ts';

/** Located refs are pruned oldest-first past this bound so the map cannot grow unboundedly. */
const MAX_STORED_REFS = 2048;

/**
 * Safety valve on nodes in one observation. The contract has no way to report
 * a truncated tree, so this must stay well above real documents and let the
 * runner's observation byte budget - visible in the prompt and the report -
 * be the effective limit.
 */
const MAX_OBSERVED_NODES = 3_000;

/** Budget for capturing the main document, still capped by the operation timeout. */
const DOCUMENT_CAPTURE_TIMEOUT_MS = 15_000;

/** Bounded settle before an observation so a committing navigation is not raced. */
const SETTLE_TIMEOUT_MS = 5_000;

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

const STATE_FORMAT = 'playwright-storage-state';

/** Default budget Playwright applies to context operations that carry no explicit timeout. */
const CONTEXT_DEFAULT_TIMEOUT_MS = 30_000;

/** The shape Playwright accepts as a context's seeded storage. */
type StorageState = NonNullable<NonNullable<Parameters<Browser['newContext']>[0]>['storageState']>;

export interface PlaywrightOptions {
  /** Browser engine; defaults to chromium. */
  readonly browser?: BrowserName;
  /** Initial viewport of every attempt's page. */
  readonly viewport?: { readonly width: number; readonly height: number };
}

export class PlaywrightSurface {
  readonly dialogs = new DialogRouter();

  private readonly browserName: BrowserName;
  private readonly pool = new BrowserPool();
  private readonly viewport: { readonly width: number; readonly height: number };
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private app: BackendAppInfo = { allowedOrigins: [] };
  private testIdAttribute = 'data-testid';
  private headed = false;
  private artifactsDir = '';
  private refCounter = 0;
  private artifactCounter = 0;
  private tracing = false;
  /** Locator-backed refs from `locate`; they hold no live handles. */
  private readonly refs = new Map<string, ActionTarget>();
  /**
   * Handle-backed refs of the newest observation. One observation is one
   * handle generation: the whole map is swapped atomically per `observe()`,
   * and the superseded generation is disposed in one sweep. Keeping these out
   * of `refs` means locator-ref eviction can never destroy a handle an
   * in-flight observation still references.
   */
  private observationRefs = new Map<string, ActionTarget>();

  constructor(options: PlaywrightOptions) {
    this.browserName = options.browser ?? 'chromium';
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
  }

  // --- lifecycle ---

  /** Provisions and launches the shared browser once per worker. */
  async init(info: BackendInitInfo): Promise<void> {
    this.app = info.app;
    this.testIdAttribute = info.testIdAttribute;
    this.headed = info.headed;
    await ensureBrowsersInstalled([this.browserName]);
    if (info.signal.aborted) {
      throw new BackendError('CANCELLED', 'backend init cancelled', { retryable: false });
    }
    try {
      this.browser = await this.pool.acquire(this.browserName, this.headed, BROWSER_LAUNCH_TIMEOUT_MS);
    } catch (cause) {
      throw new BackendError('BACKEND_FAILURE', `browser launch failed: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
  }

  /** Opens one fresh browser context for the attempt. */
  async startAttempt(context: BackendAttemptContext): Promise<void> {
    this.artifactsDir = context.artifactsDir;
    this.dialogs.reset();
    await this.openContext(undefined);
  }

  /** Closes the attempt's context and releases every ref it minted. Idempotent. */
  async endAttempt(): Promise<void> {
    if (this.tracing && this.context !== null) {
      await this.context.tracing.stop().catch(() => undefined);
      this.tracing = false;
    }
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    PlaywrightSurface.disposeGeneration(this.observationRefs);
    this.observationRefs = new Map();
    this.refs.clear();
  }

  /** Closes the shared browser process. Idempotent. */
  async dispose(): Promise<void> {
    await this.endAttempt();
    this.browser = null;
    await this.pool.dispose();
  }

  private requireBrowser(): Browser {
    if (this.browser === null || !this.browser.isConnected()) {
      throw new BackendError('BACKEND_FAILURE', 'the browser is not running; init did not complete', {
        retryable: false,
      });
    }
    return this.browser;
  }

  /** Creates the attempt's context, rolling back to no context on failure. */
  private async openContext(storageState: StorageState | undefined): Promise<void> {
    try {
      const browser = this.requireBrowser();
      this.context = await browser.newContext({
        viewport: this.viewport,
        acceptDownloads: true,
        ...(storageState === undefined ? {} : { storageState }),
      });
      this.context.setDefaultTimeout(CONTEXT_DEFAULT_TIMEOUT_MS);
      this.context.on('dialog', (dialog) => {
        void this.dialogs.dispatch(dialog);
      });
    } catch (cause) {
      await this.context?.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      if (cause instanceof BackendError) throw cause;
      throw new BackendError('BACKEND_FAILURE', `browser context launch failed: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
  }

  // --- page access shared with the web fixture ---

  requirePage(): Page {
    this.dialogs.throwPending();
    if (this.page === null || this.page.isClosed()) {
      throw invalidState('no app page is open; call app.open() or web.goto() first');
    }
    return this.page;
  }

  requireContext(): BrowserContext {
    if (this.context === null) throw invalidState('no attempt is running');
    return this.context;
  }

  async ensurePage(): Promise<Page> {
    const context = this.requireContext();
    if (this.page === null || this.page.isClosed()) {
      this.page = await context.newPage();
    }
    return this.page;
  }

  get attemptArtifactsDir(): string {
    return this.artifactsDir;
  }

  /** Closes the current context and opens a fresh one, seeded or clean. */
  private async replaceContext(storageState: StorageState | undefined): Promise<void> {
    await this.requireContext().close();
    this.context = null;
    this.page = null;
    await this.openContext(storageState);
  }

  private requireBaseUrl(): string {
    if (this.app.baseUrl === undefined) {
      throw invalidState('no app URL is configured; set app.url before relaunching the app');
    }
    return this.app.baseUrl;
  }

  private checkOperation(operation: OperationContext): void {
    if (operation.signal.aborted) {
      throw new BackendError('CANCELLED', 'operation cancelled', { retryable: false });
    }
  }

  /**
   * Checks cancellation, runs fn, and translates raw errors at the contract
   * boundary. `translate` overrides the default translation for operations
   * with a documented retryable failure mode.
   */
  async guard<T>(
    operation: OperationContext,
    label: string,
    fn: () => Promise<T>,
    translate: (cause: unknown, label: string) => BackendError = translatePwError,
  ): Promise<T> {
    this.checkOperation(operation);
    try {
      return await fn();
    } catch (cause) {
      throw translate(cause, label);
    }
  }

  private mintId(): string {
    this.refCounter += 1;
    return `n${this.refCounter}`;
  }

  private storeRef(target: ActionTarget): string {
    const id = this.mintId();
    this.refs.set(id, target);
    for (const oldest of this.refs.keys()) {
      if (this.refs.size <= MAX_STORED_REFS) break;
      this.refs.delete(oldest);
    }
    return id;
  }

  /** Disposes every element handle in one observation generation. */
  private static disposeGeneration(generation: ReadonlyMap<string, ActionTarget>): void {
    for (const target of generation.values()) {
      if (target.kind === 'element') void target.element.dispose().catch(() => undefined);
    }
  }

  /**
   * Ids are the backend's; revisions are the harness's. The adapter already
   * rejected a ref from a superseded resolution, so lookup is by id alone.
   */
  private lookupRef(ref: NodeRef): ActionTarget {
    const target = this.refs.get(ref.id) ?? this.observationRefs.get(ref.id);
    if (target === undefined) {
      throw new BackendError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    }
    return target;
  }

  // --- navigation and app lifecycle ---

  navigate(url: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      const page = await this.ensurePage();
      await page.goto(url, { waitUntil: 'load', timeout: operation.timeoutMs });
    });
  }

  back(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      await this.requirePage().goBack({ waitUntil: 'load', timeout: operation.timeoutMs });
    });
  }

  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      const baseUrl = this.requireBaseUrl();
      const context = this.requireContext();
      for (const page of context.pages()) await page.close();
      this.page = null;
      const page = await this.ensurePage();
      await page.goto(baseUrl, { waitUntil: 'load', timeout: operation.timeoutMs });
    });
  }

  clearState(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async () => {
      const baseUrl = this.requireBaseUrl();
      await this.replaceContext(undefined);
      const page = await this.ensurePage();
      await page.goto(baseUrl, { waitUntil: 'load', timeout: operation.timeoutMs });
    });
  }

  url(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'url', async () => this.requirePage().url());
  }

  // --- location tier ---

  /**
   * Resolves one expression to every node it currently matches, fully read,
   * in one in-page round trip. A `displayValue` query is filtered here by the
   * value each element reported, so no per-node calls are needed.
   */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(
      operation,
      'resolve',
      async () => {
        const page = this.requirePage();
        await this.validateFrames(expression);
        const projected = projectExpression(page, expression);
        const raws = await projected.locator.evaluateAll(readManySemanticsFunction, {
          testIdAttribute: this.testIdAttribute,
          secureFieldSelector: SECURE_FIELD_SELECTOR,
          mode: { kind: 'node' as const },
        });
        const nodes: SemanticNode[] = [];
        raws.forEach((raw, index) => {
          if (
            projected.displayValue !== null &&
            !matchesText(raw.value ?? '', projected.displayValue)
          ) {
            return;
          }
          // A single match keeps the strict locator, so a ref that turns
          // ambiguous between locate and perform fails loud instead of acting
          // on whichever element is first.
          const locator = raws.length === 1 ? projected.locator : projected.locator.nth(index);
          const id = this.storeRef({ kind: 'locator', locator });
          nodes.push(toSemanticNode({ id, revision: '' }, raw));
        });
        return nodes;
      },
      staleOr,
    );
  }

  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    return this.guard(
      operation,
      action.kind,
      () => {
        this.requirePage();
        return dispatchLocatorAction(this.lookupRef(ref), action, operation.timeoutMs, (other) =>
          this.lookupRef(other),
        );
      },
      (cause) => classifyActionError(cause, action),
    );
  }

  swipe(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    operation: OperationContext,
  ): Promise<void> {
    return this.guard(operation, 'swipe', () =>
      performViewportSwipe(this.requirePage(), direction, momentum ?? 'none'),
    );
  }

  /** Grammar scroll: the viewport or one observed node, without momentum. */
  scroll(
    direction: ScrollDirection,
    target: { readonly ref: NodeRef } | undefined,
    operation: OperationContext,
  ): Promise<void> {
    return this.guard(operation, 'scroll', async () => {
      if (target !== undefined) {
        await performElementSwipe(this.lookupRef(target.ref), direction, 'none', operation.timeoutMs);
        return;
      }
      await performViewportSwipe(this.requirePage(), direction, 'none');
    });
  }

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
        throw new BackendError('FRAME_NOT_FOUND', `no frame matches ${selector}`, {
          retryable: true,
        });
      }
      if (count > 1) {
        throw new BackendError('FRAME_AMBIGUOUS', `${count} frames match ${selector}`, {
          retryable: false,
        });
      }
    }
  }

  // --- artifacts ---

  /**
   * Reserves one artifact path under the attempt directory: a per-attempt
   * counter keeps names unique, the label keeps them readable.
   */
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    this.artifactCounter += 1;
    const name = `${String(this.artifactCounter).padStart(3, '0')}${
      label === undefined ? '' : `-${sanitizeFilename(label)}`
    }${extension}`;
    const relative = path.posix.join(folder, name);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', async () => {
      const page = this.requirePage();
      const { relative, absolute } = this.artifactPath('screenshots', label, '.png');
      await page.screenshot({ path: absolute, timeout: operation.timeoutMs });
      return relative;
    });
  }

  startTrace(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'trace', async () => {
      await this.requireContext().tracing.start({ screenshots: true, snapshots: true });
      this.tracing = true;
    });
  }

  stopTrace(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'trace', async () => {
      const context = this.requireContext();
      const relative = path.posix.join('trace', 'trace.zip');
      const absolute = path.join(this.artifactsDir, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      await context.tracing.stop({ path: absolute });
      this.tracing = false;
      return relative;
    });
  }

  // --- state ---

  captureState(operation: OperationContext): Promise<BackendState> {
    return this.guard(operation, 'state capture', async () => {
      const storageState = await this.requireContext().storageState({ indexedDB: true });
      return { format: STATE_FORMAT, version: 1, data: storageState };
    });
  }

  /** Replaces the attempt's context with one seeded from the snapshot. */
  restoreState(state: BackendState, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state restore', async () => {
      if (state.format !== STATE_FORMAT || state.version !== 1) {
        throw new BackendError(
          'INVALID_STATE',
          `unsupported state format ${state.format}@${String(state.version)}`,
          { retryable: false },
        );
      }
      // A string here would be read by Playwright as a file path; a session
      // envelope must never be able to point the browser at the filesystem.
      if (typeof state.data !== 'object' || state.data === null) {
        throw new BackendError('INVALID_STATE', 'state data must be a storage-state object', {
          retryable: false,
        });
      }
      await this.replaceContext(state.data as StorageState);
    });
  }

  // --- observation ---

  /**
   * Captures one atomic semantic observation. Secure fields are masked in the
   * page before the tree leaves the backend, and every node keeps a live
   * element handle valid until the next observation replaces the generation.
   *
   * With `options.pixels`, masked viewport pixels are captured alongside the
   * tree rather than after it, so the image and the node geometry describe the
   * page as closely in time as two backend calls can.
   */
  observe(operation: OperationContext, options?: BackendObserveOptions): Promise<BackendSnapshot> {
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
    options: BackendObserveOptions | undefined,
  ): Promise<BackendSnapshot> {
    const page = this.requirePage();
    // A preceding action may still be committing a navigation. Settling is
    // bounded and best-effort: a slow document never fails the observation.
    await page
      .waitForLoadState('domcontentloaded', {
        timeout: Math.min(operation.timeoutMs, SETTLE_TIMEOUT_MS),
      })
      .catch(() => undefined);
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const generation = new Map<string, ActionTarget>();
    // The screenshot masks by sweeping the page's frames, so it needs nothing
    // from the tree walk and runs with it instead of after it. Pixels never
    // fail an observation: an image the page could not produce in time gives
    // a tree-only observation, exactly like a backend that has no pixels.
    const pixelCapture =
      options?.pixels === true
        ? capturePixels(page, operation, viewport).catch(() => undefined)
        : Promise.resolve(undefined);
    let captured: Awaited<ReturnType<typeof captureDocument>>;
    let capturedPixels: PixelCapture | undefined;
    try {
      // Both halves are awaited before the generation swap, so a failed
      // observation leaves the surface on its previous generation instead of
      // publishing handles for a revision no caller ever received.
      [captured, capturedPixels] = await Promise.all([
        captureDocument(
          {
            testIdAttribute: this.testIdAttribute,
            allowedOrigins: this.app.allowedOrigins,
            mintId: () => this.mintId(),
            commit: (id: string, element: ElementHandle<Element>) => {
              generation.set(id, { kind: 'element', element });
            },
          },
          page.locator(':root'),
          {
            framePath: [],
            budget: MAX_OBSERVED_NODES,
            timeoutMs: Math.max(1, Math.min(operation.timeoutMs, DOCUMENT_CAPTURE_TIMEOUT_MS)),
          },
        ),
        pixelCapture,
      ]);
    } catch (cause) {
      PlaywrightSurface.disposeGeneration(generation);
      throw cause;
    }
    PlaywrightSurface.disposeGeneration(this.observationRefs);
    this.observationRefs = generation;
    return {
      nodes: [captured.tree],
      viewport: { width: viewport.width, height: viewport.height, scale: 1 },
      ...(capturedPixels === undefined
        ? {}
        : { pixels: capturedPixels.pixels, maskedRegionCount: capturedPixels.maskedRegionCount }),
    };
  }
}
