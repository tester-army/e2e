/** Owns one attempt's live binding, recovery, references, and recordings. */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';
import { EngineError, raceAbort, withinCleanupBudget, type EngineCleanupContext, type OperationContext, type VideoSegment, type ViewportSize } from 'e2e/engine';
import { attachPersistent, recoveryFailed, targetIdentity, type CdpEndpointResolver, type SessionBinding } from './cdp-recovery.ts';
import { connectionAbort, withConnectionBudget, withOperationDeadline, type ConnectionBudget, type OperationBound } from './operation-budget.ts';
import { RefRegistry } from './refs.ts';
import type { LeaseRecording } from './provider.ts';
import { ProviderVideo } from './provider-video.ts';
import { invalidState, translatePwError } from './support.ts';
import type { WebScreencastOptions } from './surface.ts';
import { VideoRecorder, type AttemptVideo } from './video.ts';

export type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;

interface SessionOptions {
  readonly artifactsDir: string;
  /** The emulated page size, or `null` to follow the window. */
  readonly viewport: ViewportSize | null;
  /** How the engine's own screencast records, when the provider does not record. */
  readonly screencast: WebScreencastOptions;
  readonly contextOptions: BrowserContextOptions;
  readonly acquire: (signal: AbortSignal) => Promise<Browser>;
  readonly configure: (context: BrowserContext) => Promise<void>;
  /** Starts the browser provider's own recording of the attempt's browser, when it records; the attempt records the screencast otherwise. */
  readonly record?: ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined;
  readonly persistent?: {
    readonly provision: CdpEndpointResolver;
    readonly reconnect: CdpEndpointResolver;
    /**
     * The default contexts earlier attempts rode, for an endpoint that could
     * hand one back (a `connect` resolver). Absent for a provider's lease,
     * fresh by contract: a hosted service may restore browsers from one
     * snapshot, so a new browser can carry an earlier one's context id.
     */
    readonly usedContexts?: Set<string>;
  };
}

type SessionState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly binding: SessionBinding }
  | { readonly kind: 'pending'; readonly binding: SessionBinding | undefined; readonly work: Promise<void> }
  | { readonly kind: 'failed'; readonly binding: SessionBinding | undefined; readonly error: Error }
  | { readonly kind: 'closed' };

export class AttemptSession {
  readonly refs = new RefRegistry();
  private readonly lifetime = new AbortController();
  private readonly video: AttemptVideo;
  private state: SessionState = { kind: 'empty' };
  private generation = {};
  private observed = true;
  /** Until the attempt's first page opens: a persistent browser's own first tab can serve as that page. */
  private firstPage = true;
  private requestedViewport: { readonly width: number; readonly height: number } | undefined;
  private pendingPage: { readonly binding: SessionBinding; readonly work: Promise<Page> } | undefined;

  constructor(private readonly options: SessionOptions) {
    this.video = options.record === undefined
      ? new VideoRecorder(options.artifactsDir, options.screencast)
      : new ProviderVideo(options.record, options.artifactsDir);
  }

  /** Captures an immutable connection generation for publication after asynchronous reads. */
  token(): object { return this.generation; }

  /** Rejects work belonging to a superseded connection or an ended attempt. */
  check(token: object): void {
    if (this.generation !== token || this.state.kind !== 'ready') {
      throw new EngineError('NODE_STALE', 'the connection changed while reading the screen', { retryable: true });
    }
  }

  /** An observation commits its references and freshness together against the same generation. */
  observedGeneration(token: object): void {
    this.check(token);
    this.observed = true;
  }

  /** Observation-backed pointer and keyboard input needs evidence captured after recovery. */
  requireObservation(): void {
    if (!this.observed) throw new EngineError('NODE_STALE', 'observe the screen again after CDP recovery before acting', { retryable: true });
  }

  /** Reads the only published binding. Pending work never replaces it halfway through setup. */
  current(): SessionBinding {
    if (this.state.kind === 'failed') throw this.state.error;
    if (this.state.kind !== 'ready') throw invalidState('no attempt connection is ready');
    return this.state.binding;
  }

  /** Invalidates every asynchronous read and reference at a connection or page transition. */
  private invalidate(): void {
    this.generation = {};
    this.refs.clear();
  }

  /** Opens a context for this attempt, publishing only after its handlers are installed. */
  start(signal: AbortSignal): Promise<void> {
    return withConnectionBudget({ signal: AbortSignal.any([signal, this.lifetime.signal]), timeoutMs: 60_000 }, 'connection',
      (remaining) => this.transition(undefined, remaining(), async () => {
        const persistent = this.options.persistent;
        if (persistent === undefined) {
          const browser = await this.options.acquire(remaining().signal);
          remaining();
          const context = await browser.newContext(this.options.contextOptions);
          return { browser, context, page: null };
        }
        const binding = await attachPersistent(persistent.provision, remaining());
        const { usedContexts } = persistent;
        if (usedContexts === undefined) return binding;
        const contextId = binding.identity.contextId;
        if (usedContexts.has(contextId)) {
          await binding.browser.close().catch(() => undefined);
          throw recoveryFailed('cdpEndpoint reused a browser from a previous attempt; provision a fresh browser');
        }
        usedContexts.add(contextId);
        return binding;
      }));
  }

  /** Shares one reconnect, then dispatches once with the time that remains, bounded by the operation's budget unless it runs test code. */
  async run<T>(
    operation: OperationContext,
    label: string,
    work: (operation: OperationContext) => Promise<T>,
    bound: OperationBound = 'deadline',
  ): Promise<T> {
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal]);
    if (signal.aborted) throw connectionAbort(signal, label);
    if (this.state.kind === 'failed') throw this.state.error;
    const persistent = this.options.persistent;
    const reconnect = (
      this.state.kind === 'pending' || (this.state.kind === 'ready' && !this.state.binding.browser.isConnected())
    );
    const endsAt = Date.now() + operation.timeoutMs;
    // Recovery is the engine's own work, so the deadline bounds it whatever the operation runs.
    if (persistent !== undefined && reconnect) {
      await withConnectionBudget({ signal, timeoutMs: operation.timeoutMs }, label, async (remaining) => {
        if (this.state.kind === 'pending') {
          await raceAbort(this.state.work, remaining().signal, 'CDP recovery');
          return;
        }
        const previous = this.current();
        this.observed = false;
        await this.transition(previous, remaining(), async () => {
          await this.video.pageClosing();
          return attachPersistent(persistent.reconnect, remaining(), previous.identity);
        }, true);
      });
    }
    const left = endsAt - Date.now();
    if (left <= 0) throw new EngineError('OPERATION_TIMEOUT', `${label} timed out`, { retryable: false });
    return withOperationDeadline({ signal, timeoutMs: left }, label, (remaining) => work({ ...operation, ...remaining() }), bound);
  }

  /** Owns a candidate through configuration and recording setup, then publishes it once. */
  private async transition(
    previous: SessionBinding | undefined,
    budget: ConnectionBudget,
    open: () => Promise<SessionBinding>,
    recover = false,
  ): Promise<void> {
    if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
    this.invalidate();
    const running = Promise.resolve().then(async () => {
      if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
      const candidate = await open();
      const close = () => { void this.release(candidate).catch(() => undefined); };
      budget.signal.addEventListener('abort', close, { once: true });
      try {
        if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
        await this.options.configure(candidate.context);
        if (recover && candidate.page !== null) {
          const size = previous?.page?.viewportSize() ?? this.requestedViewport ?? this.options.viewport;
          if (size !== null) await candidate.page.setViewportSize(size);
          await this.video.pageOpened(candidate.page);
        }
        if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
        if (this.state !== pending) throw connectionAbort(this.lifetime.signal, 'connection');
        this.state = { kind: 'ready', binding: candidate };
      } catch (cause) {
        await this.release(candidate).catch(() => undefined);
        throw cause;
      } finally {
        budget.signal.removeEventListener('abort', close);
      }
    });
    const work = raceAbort(running, budget.signal, 'connection').catch((cause: unknown) => {
      const error = budget.signal.aborted ? connectionAbort(budget.signal, 'connection') : translatePwError(cause, 'connection');
      if (this.state === pending) this.state = { kind: 'failed', binding: previous, error };
      throw error;
    });
    const pending: SessionState = { kind: 'pending', binding: previous, work };
    this.state = pending;
    await work;
  }

  /** Shares active-page creation in call order, so a response wait can register before the first navigation. */
  async ensurePage(): Promise<Page> {
    const binding = this.current();
    if (binding.page !== null && !binding.page.isClosed()) return binding.page;
    if (this.pendingPage?.binding === binding) return await this.pendingPage.work;
    const pending = { binding, work: this.openPage(binding) };
    this.pendingPage = pending;
    try {
      return await pending.work;
    } finally {
      if (this.pendingPage === pending) this.pendingPage = undefined;
    }
  }

  /** Publishes one active page after configuration, generation checks and recording setup. */
  private async openPage(binding: SessionBinding): Promise<Page> {
    this.invalidate();
    const token = this.token();
    const page = await this.nextPage(binding.context);
    try {
      let identity = binding.identity;
      const size = this.requestedViewport ?? (identity === undefined ? null : this.options.viewport);
      if (size !== null) await page.setViewportSize(size);
      if (identity !== undefined) identity = { ...identity, target: await targetIdentity(page) };
      this.check(token);
      await this.video.pageOpened(page);
      this.check(token);
      this.state = { kind: 'ready', binding: { ...binding, page, ...(identity === undefined ? {} : { identity }) } };
      return page;
    } catch (cause) {
      await page.close().catch(() => undefined);
      throw cause;
    }
  }

  /**
   * The page the attempt shows next. A persistent browser is fresh for the
   * attempt, so its own first tab serves as the attempt's first page instead
   * of a second tab beside it, which a hosted browser's live view and
   * recording would show behind the test's. The tab is navigated to
   * `about:blank` first, so its document runs the context's init scripts
   * as a new tab's does. Every later page is a new tab.
   */
  private async nextPage(context: BrowserContext): Promise<Page> {
    const first = this.firstPage;
    this.firstPage = false;
    if (first && this.options.persistent !== undefined) {
      const initial = context.pages().find((page) => !page.isClosed());
      if (initial !== undefined) {
        await initial.goto('about:blank');
        return initial;
      }
    }
    return context.newPage();
  }

  /** Sizes the open page, if any, and every page this attempt opens after it. */
  async setViewport(size: { readonly width: number; readonly height: number }): Promise<void> {
    const { width, height } = size;
    if (![width, height].every((side) => Number.isInteger(side) && side >= 0)) {
      throw new Error(`the viewport needs whole, non-negative pixels, got ${width}x${height}`);
    }
    const page = this.current().page;
    if (page !== null && !page.isClosed()) await page.setViewportSize({ width, height });
    this.requestedViewport = { width, height };
  }

  /** Restarts the document while retaining this context's storage. */
  async restart(): Promise<void> {
    const binding = this.current();
    this.invalidate();
    const token = this.token();
    await this.video.pageClosing();
    for (const page of binding.context.pages()) await page.close();
    this.check(token);
    this.state = { kind: 'ready', binding: { ...binding, page: null } };
    await this.ensurePage();
  }

  /** Replaces an ordinary context; persistent recovery never advertises this capability. */
  async replace(storageState: StorageState | undefined, operation: OperationContext): Promise<void> {
    const previous = this.current();
    await this.video.pageClosing();
    await this.transition(previous, operation, async () => {
      await previous.context.close();
      const context = await previous.browser.newContext({ ...this.options.contextOptions, ...(storageState === undefined ? {} : { storageState }) });
      return { browser: previous.browser, context, page: null };
    });
    if (this.video.isArmed) await this.ensurePage();
  }

  /** Ends this attempt immediately; late work can only access this retired owner. */
  async close(budget: EngineCleanupContext): Promise<void> {
    const state = this.state;
    this.state = { kind: 'closed' };
    this.lifetime.abort();
    this.invalidate();
    if (state.kind === 'pending') await withinCleanupBudget(state.work, budget);
    const binding = 'binding' in state ? state.binding : undefined;
    if (binding === undefined) return;
    await withinCleanupBudget(this.video.abandon(budget.signal), budget);
    await withinCleanupBudget(this.release(binding), budget);
  }

  /** Ordinary contexts are engine-owned; persistent browser processes belong to the host. */
  private release(binding: SessionBinding): Promise<void> {
    return this.options.persistent === undefined ? binding.context.close() : binding.browser.close();
  }

  /**
   * Starts video once the page is open, so a provider's recording of the
   * browser starts on the attempt's own tab.
   */
  async startVideo(signal: AbortSignal): Promise<void> {
    await this.video.arm(await this.ensurePage(), signal);
  }

  /** Collects this attempt's video independently of a failed connection. */
  collectVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    return this.finalize(operation, 'video', (signal) => this.video.stop(signal));
  }

  /** Terminal artifact collection needs its own budget, but no successful UI dispatch. */
  private async finalize<T>(operation: OperationContext, label: string, collect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return this.state.kind === 'failed' || this.state.kind === 'closed'
        ? await withConnectionBudget(operation, label, (remaining) => raceAbort(() => collect(remaining().signal), remaining().signal, label))
        : await this.run(operation, label, (current) => collect(current.signal));
    } catch (cause) {
      throw translatePwError(cause, label);
    }
  }
}
