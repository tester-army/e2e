/**
 * The Playwright surface: one browser per worker, one browser context per
 * attempt, and the page every engine member delegates to. This is the closure
 * state behind `playwright()`; the engine hooks in `engine.ts` and the `web`
 * fixture in `web.ts` are thin delegates onto it. Action dispatch lives in
 * `actions.ts`, tree capture in `observation.ts`, and the recording in
 * `video.ts`; this file owns lifecycle, location, navigation, artifacts, and state.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, ElementHandle, Page, Route } from 'playwright';
import {
  EngineError,
  raceAbort,
  withinCleanupBudget,
  type EngineAppDeclaration,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EngineSnapshot,
  type EngineState,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type OperationContext,
  type ScrollDirection,
  type SemanticNode,
  type VideoSegment,
} from '@e2edev/e2e/engine';
import { matchesText } from '@e2edev/e2e/engine';
import { classifyActionError, dispatchLocatorAction } from './actions.ts';
import { BrowserConnection, connectCdp, type BrowserName } from './browser-connection.ts';
import { DialogRouter } from './dialogs.ts';
import { ensureBrowsersInstalled } from './install.ts';
import { applyPostSteps, frameSelectors, projectExpression } from './locators.ts';
import { captureDocument, toSemanticNode } from './observation.ts';
import { capturePixels, maskOptions, secureFieldMasks, type PixelCapture } from './observe.ts';
import { readHandlesSemanticsFunction, readManySemanticsFunction, SECURE_FIELD_SELECTOR } from './read-node.ts';
import { RefRegistry } from './refs.ts';
import {
  cancelled,
  DEFAULT_VIEWPORT,
  ErrorLatch,
  invalidState,
  message,
  navigationStaleOr,
  performViewportSwipe,
  sanitizeFilename,
  staleOr,
  translatePwError,
  type ActionTarget,
} from './support.ts';
import { VideoRecorder } from './video.ts';

/**
 * Safety valve on nodes in one observation. The contract has no way to report
 * a truncated tree, so this must stay well above real documents and let the
 * runner's observation byte budget - visible in the prompt and the report -
 * be the effective limit.
 */
const MAX_OBSERVED_NODES = 3_000;

/** Bounded settle before an observation so a committing navigation is not raced. */
const SETTLE_TIMEOUT_MS = 5_000;

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

const STATE_FORMAT = 'playwright-storage-state';

/** Default budget Playwright applies to context operations that carry no explicit timeout. */
const CONTEXT_DEFAULT_TIMEOUT_MS = 30_000;

/** What a Playwright trace records; one setting for every context a trace spans. */
const TRACE_OPTIONS = { screenshots: true, snapshots: true } as const;

/**
 * The object shape Playwright accepts as a context's seeded storage. The
 * string alternative is a file path, which a session envelope must never be
 * able to point the browser at, so it is excluded from the type as well as
 * checked at runtime.
 */
type StorageState = Exclude<
  NonNullable<NonNullable<Parameters<Browser['newContext']>[0]>['storageState']>,
  string
>;

type RoutePredicate = (url: URL) => boolean;
type RouteHandler = (route: Route) => Promise<void>;

interface StoredRoute {
  readonly predicate: RoutePredicate;
  readonly handler: RouteHandler;
}

/** True for the storage-state object shape; a string (a file path) or anything else is refused. */
function isStorageState(data: unknown): data is StorageState {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { cookies?: unknown }).cookies) &&
    Array.isArray((data as { origins?: unknown }).origins)
  );
}

/**
 * Attach to a remote browser over CDP instead of launching a local one. The
 * seam a hosted-browser engine plugs into: a per-run cloud session (its
 * endpoint provisioned only once the run starts) resolves through
 * `cdpEndpoint` at `init`, and again on any reconnect. CDP attach is
 * chromium-only.
 */
export interface PlaywrightConnectOptions {
  /**
   * Resolves the CDP endpoint (a `ws://`/`wss://` or `http://` DevTools URL)
   * to attach to. Async because a hosted endpoint is not known at config load;
   * called once per worker in `init`, and again at the start of any attempt
   * that finds the session dropped, so a fresh per-run URL reconnects cleanly.
   * `signal` aborts when the init or attempt that needs the browser is
   * cancelled or exceeds its budget: a resolver that provisions a session
   * should stop and release it, since a browser that arrives late is detached.
   */
  readonly cdpEndpoint: (signal: AbortSignal) => string | Promise<string>;
}

/**
 * Options of the browser engine: the app it drives (`url`, `command`,
 * `services`, `allowedOrigins`, `environment`, `identity`, `readyUrl` - the
 * engine contract's app declaration) plus the browser itself.
 */
export interface PlaywrightOptions extends EngineAppDeclaration {
  /** Browser to launch; defaults to chromium. */
  readonly browser?: BrowserName;
  /** Initial viewport of every attempt's page. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /**
   * Attach to a remote browser over CDP instead of launching locally. Requires
   * the chromium browser (the default). Wired by a hosted-browser engine.
   */
  readonly connect?: PlaywrightConnectOptions;
}

export class PlaywrightSurface {
  /**
   * Errors raised where nobody awaits them (dialog routing, route handlers)
   * wait here and fail the next step that enters the surface.
   */
  readonly latch = new ErrorLatch();
  readonly dialogs = new DialogRouter(this.latch);

  private readonly browserName: BrowserName;
  private readonly connection = new BrowserConnection();
  private readonly connect: PlaywrightConnectOptions | undefined;
  private readonly viewport: { readonly width: number; readonly height: number };
  private browser: Browser | null = null;
  /** True once init provisioned a browser; a later disconnect may then reconnect. */
  private booted = false;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private app: EngineAppInfo = { allowedOrigins: [] };
  private testIdAttribute = 'data-testid';
  private headed = false;
  private artifactsDir = '';
  private artifactCounter = 0;
  private tracing = false;
  /** Trace segments already written for this attempt; a trace cannot span two contexts. */
  private traceSegments = 0;
  /** The attempt's recording; every hook is a no-op without one. */
  private readonly video: VideoRecorder;
  /**
   * Attempt-scoped network routes. Registered on the
   * context, not a page, so they cover every page the attempt opens - the
   * first navigation included - and re-applied to each context the attempt
   * replaces on `clearState` or session restore.
   */
  private readonly routes: StoredRoute[] = [];
  /** Located and observed node refs; see `RefRegistry` for the two lifetimes. */
  private readonly refs = new RefRegistry();

  constructor(options: PlaywrightOptions) {
    this.browserName = options.browser ?? 'chromium';
    this.connect = options.connect;
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.video = new VideoRecorder(this.viewport);
  }

  // --- lifecycle ---

  /**
   * Installs the browser on first run, once per run before any worker.
   * A CDP attach uses the remote's browser, so only a local launch needs the
   * browser here. The download narrates through `info.log` and is bounded by
   * the run's interrupt alone, never by a launch budget.
   */
  async prepare(info: EnginePrepareInfo): Promise<void> {
    if (this.connect !== undefined) return;
    await ensureBrowsersInstalled([this.browserName], { env: info.env, signal: info.signal, log: info.log });
  }

  /** Provisions the shared browser once per worker: a local launch, or a CDP attach. */
  async init(info: EngineInitInfo): Promise<void> {
    this.app = info.app;
    this.testIdAttribute = info.testIdAttribute;
    this.headed = info.headed;
    // The browser was installed in `prepare`; a launch or attach is the one
    // boot step left that can outlive a launch budget, and it honours the
    // init signal.
    this.browser = await this.acquireBrowser(info.signal);
    this.booted = true;
  }

  /**
   * Provisions the shared browser through the shared connection — a launch, or a CDP attach
   * via the connector — bounded by `signal`. Checked before the endpoint is
   * resolved: a cancelled caller must never provision a remote session it will
   * not use.
   */
  private async acquireBrowser(signal: AbortSignal): Promise<Browser> {
    const verb = this.connect === undefined ? 'launch' : 'connect';
    if (signal.aborted) throw cancelled(`browser ${verb} cancelled`);
    try {
      return await raceAbort(
        this.connection.acquire(this.browserName, this.headed, BROWSER_LAUNCH_TIMEOUT_MS, this.connector(signal)),
        signal,
        `browser ${verb}`,
      );
    } catch (cause) {
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('ENGINE_FAILURE', `browser ${verb} failed: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
  }

  /**
   * Builds the connection's connector when attaching over CDP; undefined for a local
   * launch. The connector honours `signal` at every await: the resolver
   * receives it, the endpoint is not used once aborted, and a browser that
   * connects after cancellation is detached at once rather than cached — the
   * host's session is never held by an init or attempt that already gave up.
   */
  private connector(signal: AbortSignal): (() => Promise<Browser>) | undefined {
    const connect = this.connect;
    if (connect === undefined) return undefined;
    return async () => {
      const endpoint = await connect.cdpEndpoint(signal);
      if (signal.aborted) throw cancelled('browser connect cancelled');
      if (typeof endpoint !== 'string' || endpoint.trim() === '') {
        throw new EngineError('ENGINE_FAILURE', 'connect.cdpEndpoint resolved to an empty CDP endpoint', {
          retryable: false,
        });
      }
      const browser = await connectCdp(endpoint, BROWSER_LAUNCH_TIMEOUT_MS);
      if (signal.aborted) {
        await browser.close().catch(() => undefined);
        throw cancelled('browser connect cancelled');
      }
      return browser;
    };
  }

  /**
   * The browser an attempt starts on. A booted surface whose browser has since
   * disconnected — a dropped remote session, a crashed process — reacquires
   * through the shared connection, which evicts the dead browser and, for a CDP attach,
   * runs the endpoint resolver again for a fresh session. Reconnection is an
   * attempt-start decision only: mid-attempt the browser must stay the one the
   * test began on, so `requireBrowser` stays strict there.
   */
  private async ensureBrowser(signal: AbortSignal): Promise<Browser> {
    if (this.browser !== null && this.browser.isConnected()) return this.browser;
    if (!this.booted) return this.requireBrowser();
    this.browser = await this.acquireBrowser(signal);
    return this.browser;
  }

  /**
   * Opens one fresh browser context for the attempt. A second call while a
   * context is open is a harness bug, not a relaunch: honouring it would leak
   * the first context and leave the dialog router listening to both.
   */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.context !== null) {
      throw new EngineError('INVALID_STATE', 'an attempt is already running', { retryable: false });
    }
    this.artifactsDir = context.artifactsDir;
    this.artifactCounter = 0;
    this.traceSegments = 0;
    this.video.reset(context.artifactsDir);
    this.routes.length = 0;
    this.dialogs.reset();
    await this.openContext(undefined, context.signal);
  }

  /**
   * Closes the attempt's context and releases every ref it minted, within the
   * cleanup budget: once `context.signal` aborts, the surface stops waiting on
   * Playwright and abandons the close. Idempotent, and a no-op before
   * `startAttempt`.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    await this.closeContext(context);
    this.refs.clear();
  }

  /** Closes the shared browser process within the cleanup budget. Idempotent, and safe cold. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    await this.endAttempt(context);
    this.browser = null;
    this.booted = false;
    await withinCleanupBudget(this.connection.dispose(), context);
  }

  /** Stops any trace and closes the current context, best-effort, within the budget. */
  private async closeContext(budget: EngineCleanupContext): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context === null) return;
    // The harness stops the video before the attempt ends; a segment still
    // recording here belongs to an attempt cut short, and is kept as far as it got.
    if (this.video.isRecording) await withinCleanupBudget(this.video.pageClosing(), budget);
    if (this.tracing) {
      this.tracing = false;
      await withinCleanupBudget(context.tracing.stop(), budget);
    }
    await withinCleanupBudget(context.close(), budget);
  }

  private requireBrowser(): Browser {
    if (this.browser === null || !this.browser.isConnected()) {
      throw new EngineError('ENGINE_FAILURE', 'the browser is not running; init did not complete', {
        retryable: false,
      });
    }
    return this.browser;
  }

  /**
   * Creates the attempt's context, rolling back to no context on failure. With
   * `reacquire`, a disconnected browser is reacquired first (attempt start);
   * without it the browser must already be connected (mid-attempt replace).
   */
  private async openContext(
    storageState: StorageState | undefined,
    reacquire?: AbortSignal,
  ): Promise<void> {
    try {
      const browser =
        reacquire === undefined ? this.requireBrowser() : await this.ensureBrowser(reacquire);
      this.context = await browser.newContext({
        viewport: this.viewport,
        acceptDownloads: true,
        ...(storageState === undefined ? {} : { storageState }),
      });
      this.context.setDefaultTimeout(CONTEXT_DEFAULT_TIMEOUT_MS);
      this.context.on('dialog', (dialog) => {
        void this.dialogs.dispatch(dialog);
      });
      for (const stored of this.routes) await this.context.route(stored.predicate, stored.handler);
    } catch (cause) {
      await this.context?.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('ENGINE_FAILURE', `browser context launch failed: ${message(cause)}`, {
        retryable: false,
        cause,
      });
    }
  }

  // --- network routes shared with the web fixture ---

  /** Registers one attempt-scoped route on the current context. */
  async route(predicate: RoutePredicate, handler: RouteHandler): Promise<void> {
    const context = this.requireContext();
    this.routes.push({ predicate, handler });
    await context.route(predicate, handler);
  }

  /** Removes one registered route from the attempt and the current context. */
  async unroute(predicate: RoutePredicate, handler: RouteHandler): Promise<void> {
    const context = this.requireContext();
    const index = this.routes.findIndex(
      (stored) => stored.predicate === predicate && stored.handler === handler,
    );
    if (index !== -1) this.routes.splice(index, 1);
    await context.unroute(predicate, handler);
  }

  // --- page access shared with the web fixture ---

  requirePage(): Page {
    this.latch.throwPending();
    if (this.page === null || this.page.isClosed()) {
      throw invalidState('no app page is open; call app.open() or web.goto() first');
    }
    return this.page;
  }

  requireContext(): BrowserContext {
    this.latch.throwPending();
    if (this.context === null) throw invalidState('no attempt is running');
    return this.context;
  }

  async ensurePage(): Promise<Page> {
    const context = this.requireContext();
    if (this.page === null || this.page.isClosed()) {
      this.page = await context.newPage();
      await this.video.pageOpened(this.page);
    }
    return this.page;
  }

  /**
   * Closes the current context and opens a fresh one, seeded or clean. Every
   * ref minted so far pointed into the closed context, so all of them are
   * released: a later `perform` on one reads as stale, never as a dead target.
   *
   * A Playwright trace is bound to one context, so an active trace is closed
   * as its own segment (`trace/trace-part<n>.zip`, alongside the final
   * `trace/trace.zip`) and recording resumes on the new context. `tracing`
   * stays truthful throughout: false while no context exists, true again only
   * once the new context records.
   */
  private async replaceContext(storageState: StorageState | undefined): Promise<void> {
    const context = this.requireContext();
    // The old context is released from the surface before anything awaits, so
    // a trace segment or close that fails cannot leave the surface pointing at
    // a context it meant to replace.
    this.context = null;
    this.page = null;
    this.refs.clear();
    const resumeTrace = await this.closeTraceSegment(context);
    // A screencast is the old page's: its segment closes here, while the page
    // can still flush it, and the next page the new context opens starts the
    // following one.
    await this.video.pageClosing();
    await context.close();
    await this.openContext(storageState);
    // The recording's next segment opens the new context's page before the
    // trace resumes, for the same reason `startVideo` opens the first one.
    if (this.video.isArmed) await this.ensurePage();
    if (resumeTrace) await this.resumeTrace();
  }

  /**
   * Closes the active trace as its own segment (`trace/trace-part<n>.zip`)
   * and reports whether one was active. `tracing` is cleared before anything
   * awaits, so a segment that fails to write cannot leave the surface
   * believing a trace still records; the segment itself is best-effort, the
   * final trace still records from where tracing resumes.
   */
  private async closeTraceSegment(context: BrowserContext): Promise<boolean> {
    if (!this.tracing) return false;
    this.tracing = false;
    this.traceSegments += 1;
    await context.tracing
      .stop({ path: this.tracePath(`trace-part${String(this.traceSegments)}`).absolute })
      .catch(() => undefined);
    return true;
  }

  /** Resumes tracing on the current context after `closeTraceSegment`. */
  private async resumeTrace(): Promise<void> {
    await this.requireContext().tracing.start(TRACE_OPTIONS);
    this.tracing = true;
  }

  private requireBaseUrl(): string {
    if (this.app.baseUrl === undefined) {
      throw invalidState('no app URL is configured; pass `url` to playwright() before relaunching the app');
    }
    return this.app.baseUrl;
  }

  /**
   * The single entry of every operation: rethrows an error latched on an
   * unawaited path, refuses a cancelled operation, races `fn` against the
   * operation signal so an abort mid-call surfaces as `CANCELLED` instead of
   * waiting out Playwright, and translates raw errors at the contract
   * boundary. `translate` overrides the default translation for operations
   * with a documented retryable failure mode.
   */
  async guard<T>(
    operation: OperationContext,
    label: string,
    fn: () => Promise<T>,
    translate: (cause: unknown, label: string) => Error = translatePwError,
  ): Promise<T> {
    this.latch.throwPending();
    if (operation.signal.aborted) throw cancelled(`${label} cancelled`);
    try {
      return await raceAbort(fn, operation.signal, label);
    } catch (cause) {
      throw translate(cause, label);
    }
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
    return this.guard(operation, 'restart', async () => {
      const baseUrl = this.requireBaseUrl();
      const context = this.requireContext();
      // The recording's segment ends before its page closes: Playwright writes
      // nothing for a screencast whose page went away first. Under a recording
      // the trace closes as a segment too: a trace attaches its own 800-pixel
      // screencast to every page the moment it opens, and a page's first
      // client sizes its screencast, so the recording must be that client on
      // the new page, as it is at `startVideo`.
      await this.video.pageClosing();
      const resumeTrace = this.video.isArmed ? await this.closeTraceSegment(context) : false;
      for (const page of context.pages()) await page.close();
      this.page = null;
      const page = await this.ensurePage();
      if (resumeTrace) await this.resumeTrace();
      await page.goto(baseUrl, { waitUntil: 'load', timeout: operation.timeoutMs });
    });
  }

  clearState(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', async () => {
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
   * value each element reported, so no per-node calls are needed; any
   * `first`/`last`/`nth` on such a query then selects among those matches, and
   * a filter placed after a position is checked on the selected element. A
   * `visible` query drops the candidates whose hidden state the same read
   * reported before either of those, so a position is among shown matches.
   */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(
      operation,
      'locate',
      async () => {
        const page = this.requirePage();
        await this.validateFrames(expression);
        const projected = projectExpression(page, expression);
        const { displayValue, name, steps } = projected;
        const readOptions = {
          testIdAttribute: this.testIdAttribute,
          secureFieldSelector: SECURE_FIELD_SELECTOR,
          mode: { kind: 'node' as const },
        };
        // A predicate-filtered match is one element among many candidates, and the candidate
        // list is broad (every labelable control, every input with a value). Re-resolving it
        // by position at action time would act on a neighbor whenever the page inserted or
        // removed an element in between, so such matches are pinned to element handles: the
        // handles are taken first and the semantics are read from those very handles, so what
        // was read and what is acted on are one set of elements by construction.
        const handles =
          displayValue !== null || name !== null
            ? ((await projected.locator.elementHandles()) as ElementHandle<Element>[])
            : null;
        const first = handles?.[0];
        const raws =
          handles === null
            ? await projected.locator.evaluateAll(readManySemanticsFunction, readOptions)
            : first === undefined
              ? []
              : await first.evaluate(readHandlesSemanticsFunction, { elements: handles, options: readOptions });
        const candidates = raws
          .map((raw, index) => ({ raw, index }))
          .filter(({ raw }) => !(projected.visible && raw.states.hidden));
        // An exact label query matches any of the control's labels as the engine's reader names
        // them, so text a label marks aria-hidden (a required-field marker) never hides a field,
        // and an aria-label override or a second label does not either.
        const predicate =
          displayValue !== null
            ? (raw: (typeof raws)[number]) => matchesText(raw.value ?? '', displayValue)
            : name !== null
              ? (raw: (typeof raws)[number]) =>
                  raw.labels !== null && raw.labels.some((label) => matchesText(label, name))
              : null;
        const matches =
          predicate === null
            ? candidates
            : await applyPostSteps(
                candidates.filter(({ raw }) => predicate(raw)),
                steps,
                // A filter after a position runs on that one element alone.
                async ({ index }, options) =>
                  (await projected.locator.nth(index).filter(options).count()) > 0,
              );
        if (handles !== null) {
          // Only the matches keep their handles; the rest would otherwise live until the page goes.
          const kept = new Set(matches.map(({ index }) => index));
          for (const [index, handle] of handles.entries()) {
            if (!kept.has(index)) void handle.dispose().catch(() => undefined);
          }
        }
        return matches.map(({ raw, index }) => {
          const pinned = handles?.[index];
          // A single match keeps the strict locator, so a ref that turns
          // ambiguous between locate and perform fails loud instead of acting
          // on whichever element is first.
          const locator = raws.length === 1 ? projected.locator : projected.locator.nth(index);
          const id = this.refs.storeLocated(
            pinned === undefined ? { kind: 'locator', locator } : { kind: 'element', element: pinned },
          );
          return toSemanticNode({ id, revision: '' }, raw);
        });
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
        return dispatchLocatorAction(this.refs.lookup(ref), action, operation.timeoutMs, (other) =>
          this.refs.lookup(other),
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
        throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, {
          retryable: true,
        });
      }
      if (count > 1) {
        throw new EngineError('FRAME_AMBIGUOUS', `${count} frames match ${selector}`, {
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

  /** Redacted at the source: secure fields in every frame are masked, as in observation pixels. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', async () => {
      const page = this.requirePage();
      const { relative, absolute } = this.artifactPath('screenshots', label, '.png');
      await page.screenshot({
        path: absolute,
        timeout: operation.timeoutMs,
        ...maskOptions(secureFieldMasks(page)),
      });
      return relative;
    });
  }

  /** Reserves one trace file under the attempt directory. */
  private tracePath(name: string): { relative: string; absolute: string } {
    const relative = path.posix.join('trace', `${name}.zip`);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  startTrace(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'trace', async () => {
      await this.requireContext().tracing.start(TRACE_OPTIONS);
      this.tracing = true;
    });
  }

  stopTrace(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'trace', async () => {
      const context = this.requireContext();
      const { relative, absolute } = this.tracePath('trace');
      await context.tracing.stop({ path: absolute });
      this.tracing = false;
      return relative;
    });
  }

  // --- video ---

  /**
   * Arms the attempt's recording, opening the attempt's page if it has none
   * yet. Eager on purpose: a page has one screencast, sized by its first
   * client, and a trace started afterwards (the harness starts the video
   * first) then records its frames at the recording's size rather than the
   * recording inheriting the trace's 800-pixel cap. Pages a replaced context
   * opens later resume in `ensurePage`.
   */
  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', async () => {
      const page = await this.ensurePage();
      await this.video.arm(page);
    });
  }

  /** Finishes the recording and returns every segment this attempt wrote, in order. */
  stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    return this.guard(operation, 'video', () => this.video.stop());
  }

  // --- state ---

  captureState(operation: OperationContext): Promise<EngineState> {
    return this.guard(operation, 'state capture', async () => {
      const storageState = await this.requireContext().storageState({ indexedDB: true });
      return { format: STATE_FORMAT, version: 1, data: storageState };
    });
  }

  /** Replaces the attempt's context with one seeded from the snapshot. */
  restoreState(state: EngineState, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state restore', async () => {
      if (state.format !== STATE_FORMAT || state.version !== 1) {
        throw new EngineError(
          'INVALID_STATE',
          `unsupported state format ${state.format}@${String(state.version)}`,
          { retryable: false },
        );
      }
      // A string here would be read by Playwright as a file path; a session
      // envelope must never be able to point the browser at the filesystem.
      if (!isStorageState(state.data)) {
        throw new EngineError('INVALID_STATE', 'state data must be a storage-state object', {
          retryable: false,
        });
      }
      await this.replaceContext(state.data);
    });
  }

  // --- observation ---

  /**
   * Captures one atomic semantic observation. Secure fields are masked in the
   * page before the tree leaves the engine, and every node keeps a live
   * element handle valid until the next observation replaces the generation.
   *
   * With `options.pixels`, masked viewport pixels are captured alongside the
   * tree rather than after it, so the image and the node geometry describe the
   * page as closely in time as two engine calls can.
   */
  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
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
    options: EngineObserveOptions | undefined,
  ): Promise<EngineSnapshot> {
    const page = this.requirePage();
    // One deadline for the whole observation: settle, every document, and the
    // pixels each spend from what remains of it, never from the full budget.
    const deadline = Date.now() + operation.timeoutMs;
    // A preceding action may still be committing a navigation. Settling is
    // bounded and best-effort: a slow document never fails the observation.
    await page
      .waitForLoadState('domcontentloaded', {
        timeout: Math.max(1, Math.min(operation.timeoutMs, SETTLE_TIMEOUT_MS)),
      })
      .catch(() => undefined);
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const generation = new Map<string, ActionTarget>();
    // The screenshot masks by sweeping the page's frames, so it needs nothing
    // from the tree walk and runs with it instead of after it. Pixels never
    // fail an observation: an image the page could not produce in time gives
    // a tree-only observation, exactly like an engine that has no pixels.
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
            idSeed: () => this.refs.idSeed(),
            advanceIds: (nextId) => this.refs.advanceIds(nextId),
            commit: (id: string, element: ElementHandle<Element>) => {
              generation.set(id, { kind: 'element', element });
            },
          },
          page,
          { framePath: [], budget: MAX_OBSERVED_NODES, deadline },
        ),
        pixelCapture,
      ]);
    } catch (cause) {
      RefRegistry.dispose(generation);
      throw cause;
    }
    // `guard` already rejected the caller on abort; the capture kept running.
    // Its generation must not be published over the one the caller still
    // holds refs into, nor destroy that one.
    if (operation.signal.aborted) {
      RefRegistry.dispose(generation);
      throw cancelled('observe cancelled');
    }
    this.refs.publish(generation);
    return {
      nodes: [captured.tree],
      viewport: { width: viewport.width, height: viewport.height, scale: 1 },
      ...(capturedPixels === undefined
        ? {}
        : { pixels: capturedPixels.pixels, maskedRegionCount: capturedPixels.maskedRegionCount }),
    };
  }
}
