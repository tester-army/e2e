/** Owns one attempt's live binding, recovery, references, and recordings. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { EngineError, raceAbort, withinCleanupBudget, type EngineCleanupContext, type OperationContext, type VideoSegment } from 'e2e/engine';
import { attachPersistent, recoveryFailed, targetIdentity, type CdpEndpointResolver, type SessionBinding } from './cdp-recovery.ts';
import { connectionAbort, withConnectionBudget, type ConnectionBudget } from './operation-budget.ts';
import { RefRegistry } from './refs.ts';
import { invalidState, translatePwError } from './support.ts';
import { VideoRecorder } from './video.ts';

export type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;

interface SessionOptions {
  readonly artifactsDir: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly contextOptions: BrowserContextOptions;
  readonly acquire: (signal: AbortSignal) => Promise<Browser>;
  readonly configure: (context: BrowserContext) => Promise<void>;
  readonly persistent?: {
    readonly provision: CdpEndpointResolver;
    readonly reconnect: CdpEndpointResolver;
    readonly usedContexts: Set<string>;
  };
}

type SessionState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly binding: SessionBinding }
  | { readonly kind: 'pending'; readonly binding: SessionBinding | undefined; readonly work: Promise<void> }
  | { readonly kind: 'failed'; readonly binding: SessionBinding | undefined; readonly error: Error }
  | { readonly kind: 'closed' };

const TRACE_OPTIONS = { screenshots: true, snapshots: true } as const;

export class AttemptSession {
  readonly refs = new RefRegistry();
  private readonly lifetime = new AbortController();
  private readonly video: VideoRecorder;
  private state: SessionState = { kind: 'empty' };
  private generation = {};
  private observed = true;
  private tracing = false;
  private traceSegments = 0;
  private traceParts: string[] = [];

  constructor(private readonly options: SessionOptions) {
    this.video = new VideoRecorder(options.viewport, options.artifactsDir);
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
        const contextId = binding.identity.contextId;
        if (persistent.usedContexts.has(contextId)) {
          await binding.browser.close().catch(() => undefined);
          throw recoveryFailed('cdpEndpoint reused a browser from a previous attempt; provision a fresh browser');
        }
        persistent.usedContexts.add(contextId);
        return binding;
      }));
  }

  /** Shares one reconnect, then dispatches once with the time that remains. */
  async run<T>(operation: OperationContext, label: string, work: (operation: OperationContext) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal]);
    if (signal.aborted) throw connectionAbort(signal, label);
    if (this.state.kind === 'failed') throw this.state.error;
    const persistent = this.options.persistent;
    const reconnect = (
      this.state.kind === 'pending' || (this.state.kind === 'ready' && !this.state.binding.browser.isConnected())
    );
    if (persistent === undefined || !reconnect) return raceAbort(() => work({ ...operation, signal }), signal, label);
    return withConnectionBudget({ ...operation, signal }, label, async (remaining) => {
      if (this.state.kind === 'pending') {
        await raceAbort(this.state.work, remaining().signal, 'CDP recovery');
      } else {
        const previous = this.current();
        this.observed = false;
        await this.transition(previous, remaining(), async () => {
          await this.video.pageClosing();
          return attachPersistent(persistent.reconnect, remaining(), previous.identity);
        }, true);
      }
      const current = remaining();
      return raceAbort(() => work({ ...operation, ...current }), current.signal, label);
    });
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
    const resumeTrace = recover && this.tracing;
    if (recover) this.tracing = false;
    const running = Promise.resolve().then(async () => {
      if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
      const candidate = await open();
      const close = () => { void this.release(candidate).catch(() => undefined); };
      budget.signal.addEventListener('abort', close, { once: true });
      try {
        if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
        await this.options.configure(candidate.context);
        if (recover && candidate.page !== null) {
          await candidate.page.setViewportSize(previous?.page?.viewportSize() ?? this.options.viewport);
          await this.video.pageOpened(candidate.page);
        }
        if (resumeTrace) await candidate.context.tracing.start(TRACE_OPTIONS);
        if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
        if (this.state !== pending) throw connectionAbort(this.lifetime.signal, 'connection');
        this.tracing = resumeTrace;
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

  /** Creates the attempt's active page and records its exact target before exposing it. */
  async ensurePage(): Promise<Page> {
    const binding = this.current();
    if (binding.page !== null && !binding.page.isClosed()) return binding.page;
    this.invalidate();
    const token = this.token();
    const page = await binding.context.newPage();
    try {
      let identity = binding.identity;
      if (identity !== undefined) {
        await page.setViewportSize(this.options.viewport);
        identity = { ...identity, target: await targetIdentity(page) };
      }
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

  /** Restarts the document while retaining this context's storage. */
  async restart(): Promise<void> {
    const binding = this.current();
    this.invalidate();
    const token = this.token();
    await this.video.pageClosing();
    const resume = this.video.isArmed ? await this.closeTraceSegment(binding.context) : false;
    for (const page of binding.context.pages()) await page.close();
    this.check(token);
    this.state = { kind: 'ready', binding: { ...binding, page: null } };
    await this.ensurePage();
    if (resume) await this.startTrace();
  }

  /** Replaces an ordinary context; persistent recovery never advertises this capability. */
  async replace(storageState: StorageState | undefined, operation: OperationContext): Promise<void> {
    const previous = this.current();
    const resume = await this.closeTraceSegment(previous.context);
    await this.video.pageClosing();
    await this.transition(previous, operation, async () => {
      await previous.context.close();
      const context = await previous.browser.newContext({ ...this.options.contextOptions, ...(storageState === undefined ? {} : { storageState }) });
      return { browser: previous.browser, context, page: null };
    });
    if (this.video.isArmed) await this.ensurePage();
    if (resume) await this.startTrace();
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
    if (this.video.isRecording) await withinCleanupBudget(this.video.pageClosing(), budget);
    if (this.tracing) await withinCleanupBudget(binding.context.tracing.stop(), budget);
    await withinCleanupBudget(this.release(binding), budget);
  }

  /** Ordinary contexts are engine-owned; persistent browser processes belong to the host. */
  private release(binding: SessionBinding): Promise<void> {
    return this.options.persistent === undefined ? binding.context.close() : binding.browser.close();
  }

  /** Allocates trace paths inside this attempt's immutable artifact directory. */
  private tracePath(name: string): { relative: string; absolute: string } {
    const relative = path.posix.join('trace', `${name}.zip`);
    const absolute = path.join(this.options.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  /** Saves a replaced context's trace when it can still flush it. */
  private async closeTraceSegment(context: BrowserContext): Promise<boolean> {
    if (!this.tracing) return false;
    this.tracing = false;
    this.traceSegments += 1;
    const { relative, absolute } = this.tracePath(`trace-part${this.traceSegments}`);
    try {
      await context.tracing.stop({ path: absolute });
      this.traceParts.push(relative);
    } catch { /* A disconnected context may have lost its final trace segment. */ }
    return true;
  }

  /** Begins tracing the currently committed context. */
  async startTrace(): Promise<void> {
    const token = this.token();
    await this.current().context.tracing.start(TRACE_OPTIONS);
    this.check(token);
    this.tracing = true;
  }

  /** Returns finalized segments, including any retained before context replacement failed. */
  private async stopTrace(): Promise<string | readonly string[]> {
    const parts = this.traceParts;
    this.traceParts = [];
    if (parts.length > 0 && !this.tracing) return parts;
    const { relative, absolute } = this.tracePath('trace');
    await this.current().context.tracing.stop({ path: absolute });
    this.tracing = false;
    return parts.length === 0 ? relative : [...parts, relative];
  }

  /** Starts video before tracing can choose the page's screencast size. */
  async startVideo(): Promise<void> { await this.video.arm(await this.ensurePage()); }

  /** Collects finalized trace segments even when connection replacement failed. */
  collectTrace(operation: OperationContext): Promise<string | readonly string[]> {
    return this.finalize(operation, 'trace', () => this.stopTrace());
  }

  /** Collects this attempt's video independently of a failed connection. */
  collectVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    return this.finalize(operation, 'video', () => this.video.stop());
  }

  /** Terminal artifact collection needs its own budget, but no successful UI dispatch. */
  private async finalize<T>(operation: OperationContext, label: string, collect: () => Promise<T>): Promise<T> {
    try {
      return this.state.kind === 'failed' || this.state.kind === 'closed'
        ? await withConnectionBudget(operation, label, (remaining) => raceAbort(collect, remaining().signal, label))
        : await this.run(operation, label, collect);
    } catch (cause) {
      throw translatePwError(cause, label);
    }
  }
}
