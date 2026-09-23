/** Owns one attempt's live connection, its page stack, recovery, references, and recordings. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { EngineError, raceAbort, withinCleanupBudget, type EngineCleanupContext, type OperationContext, type VideoSegment, type ViewportSize } from 'e2e/engine';
import {
  attachPersistent,
  recoveryFailed,
  samePage,
  targetIdentity,
  type CdpEndpointResolver,
  type Connection,
  type StackedPage,
  type TargetIdentity,
} from './cdp-recovery.ts';
import { connectionAbort, withConnectionBudget, type ConnectionBudget } from './operation-budget.ts';
import { RefRegistry } from './refs.ts';
import { invalidState, translatePwError } from './support.ts';
import { VideoRecorder } from './video.ts';

export type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;

interface SessionOptions {
  readonly artifactsDir: string;
  readonly viewport: ViewportSize;
  readonly contextOptions: BrowserContextOptions;
  readonly acquire: (signal: AbortSignal) => Promise<Browser>;
  readonly configure: (context: BrowserContext) => Promise<void>;
  readonly persistent?: {
    readonly provision: CdpEndpointResolver;
    readonly reconnect: CdpEndpointResolver;
    readonly usedContexts: Set<string>;
  };
}

/** One page on the stack and the promise its close listener settles once the close has been unwound. */
interface PageEntry extends StackedPage {
  readonly unwound: Promise<void>;
}

/** The published connection: `Connection` with the session's close listener on every page. */
interface Ready extends Connection {
  readonly stack: readonly PageEntry[];
}

type SessionState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly connection: Ready }
  | { readonly kind: 'pending'; readonly connection: Ready | undefined; readonly work: Promise<void> }
  | { readonly kind: 'failed'; readonly connection: Ready | undefined; readonly error: Error }
  | { readonly kind: 'closed' };

/** What the surface reaches: the connection and the page the attempt shows, or none yet. */
interface SessionBinding {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page | null;
}

const TRACE_OPTIONS = { screenshots: true, snapshots: true } as const;

/** The page the attempt shows: the topmost entry whose page is still open. */
function viewOf<T extends StackedPage>(stack: readonly T[]): T | undefined {
  return stack.findLast((entry) => !entry.page.isClosed());
}

/**
 * The attempt's pages form a stack: the page `ensurePage` opened at the
 * bottom, each popup `enterPopup` made active above it, the active page on
 * top. Every entered page carries one close listener, so a page the app
 * closes itself and one the test closes unwind the same way: references die
 * with the page and the recording resumes on the next open page below.
 *
 * A closed page stays on the stack until the next push or recovery compacts
 * it. A transport drop closes every page of the context, and at that moment
 * a close cannot be told from the app's `window.close()`; recovery needs the
 * targets of the whole stack to find the pages again, so the listener never
 * removes an entry, and the view is the topmost entry whose page is open.
 */
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

  /** Reads the only published connection. Pending work never replaces it halfway through setup. */
  private connection(): Ready {
    if (this.state.kind === 'failed') throw this.state.error;
    if (this.state.kind !== 'ready') throw invalidState('no attempt connection is ready');
    return this.state.connection;
  }

  /** The published connection and the page on top of its stack, derived rather than stored. */
  current(): SessionBinding {
    const { browser, context, stack } = this.connection();
    return { browser, context, page: viewOf(stack)?.page ?? null };
  }

  /** The page an entered page's handle names now: the same page, or its successor after a recovery. */
  pageOf(handle: StackedPage): Page | undefined {
    return this.state.kind === 'ready' ? this.state.connection.stack.find((entry) => samePage(entry, handle))?.page : undefined;
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
          return { browser, context, stack: [] };
        }
        const connection = await attachPersistent(persistent.provision, remaining());
        if (persistent.usedContexts.has(connection.contextId)) {
          await connection.browser.close().catch(() => undefined);
          throw recoveryFailed('cdpEndpoint reused a browser from a previous attempt; provision a fresh browser');
        }
        persistent.usedContexts.add(connection.contextId);
        return connection;
      }));
  }

  /** Shares one reconnect, then dispatches once with the time that remains. */
  async run<T>(operation: OperationContext, label: string, work: (operation: OperationContext) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal]);
    if (signal.aborted) throw connectionAbort(signal, label);
    if (this.state.kind === 'failed') throw this.state.error;
    const persistent = this.options.persistent;
    const reconnect = (
      this.state.kind === 'pending' || (this.state.kind === 'ready' && !this.state.connection.browser.isConnected())
    );
    if (persistent === undefined || !reconnect) return raceAbort(() => work({ ...operation, signal }), signal, label);
    return withConnectionBudget({ ...operation, signal }, label, async (remaining) => {
      if (this.state.kind === 'pending') {
        await raceAbort(this.state.work, remaining().signal, 'CDP recovery');
      } else {
        const previous = this.connection();
        if (previous.contextId === undefined) throw recoveryFailed('the connection has no persistent context to recover');
        const identity = { contextId: previous.contextId, stack: previous.stack };
        this.observed = false;
        await this.transition(previous, remaining(), async () => {
          await this.video.pageClosing();
          return attachPersistent(persistent.reconnect, remaining(), identity);
        }, true);
      }
      const current = remaining();
      return raceAbort(() => work({ ...operation, ...current }), current.signal, label);
    });
  }

  /**
   * Owns a candidate through configuration, page adoption, and recording
   * setup, then publishes it once, replacing the whole stack. A recovered
   * stack gets each page's viewport back and the session's close listener on
   * every page; the recording resumes on the page on top.
   */
  private async transition(
    previous: Ready | undefined,
    budget: ConnectionBudget,
    open: () => Promise<Connection>,
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
        const stack = candidate.stack.map((entered) => ({ ...entered, unwound: this.watch(entered.page) }));
        for (const entry of stack) {
          const before = previous?.stack.find((known) => samePage(known, entry));
          await entry.page.setViewportSize(before?.page.viewportSize() ?? this.options.viewport);
        }
        const view = viewOf(stack);
        if (view !== undefined) await this.video.pageOpened(view.page);
        if (resumeTrace) await candidate.context.tracing.start(TRACE_OPTIONS);
        if (budget.signal.aborted) throw connectionAbort(budget.signal, 'connection');
        if (this.state !== pending) throw connectionAbort(this.lifetime.signal, 'connection');
        this.tracing = resumeTrace;
        this.state = { kind: 'ready', connection: { ...candidate, stack } };
      } catch (cause) {
        await this.release(candidate).catch(() => undefined);
        throw cause;
      } finally {
        budget.signal.removeEventListener('abort', close);
      }
    });
    const work = raceAbort(running, budget.signal, 'connection').catch((cause: unknown) => {
      const error = budget.signal.aborted ? connectionAbort(budget.signal, 'connection') : translatePwError(cause, 'connection');
      if (this.state === pending) this.state = { kind: 'failed', connection: previous, error };
      throw error;
    });
    const pending: SessionState = { kind: 'pending', connection: previous, work };
    this.state = pending;
    await work;
  }

  /**
   * Registers a page's one close listener and returns the promise it settles
   * once the close is unwound. Registered before the first await of any
   * adoption, so a page that closes during its own setup is still accounted
   * for; a page already closed has nothing to wait for.
   */
  private watch(page: Page): Promise<void> {
    if (page.isClosed()) return Promise.resolve();
    return new Promise((resolve) => {
      page.once('close', () => { resolve(this.unwind(page)); });
    });
  }

  /**
   * A page closed. When it was the view (no open page above it), references
   * die with it and the recording resumes on the next open page below; the
   * entry stays for recovery to find again or the next push to compact. A
   * page a transition or the attempt's end already retired is nobody's view.
   * A screencast that cannot restart leaves a gap in the recording; the
   * segments that did finish still land.
   */
  private async unwind(page: Page): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const { stack } = this.state.connection;
    const index = stack.findIndex((entry) => entry.page === page);
    if (index === -1 || viewOf(stack.slice(index + 1)) !== undefined) return;
    this.invalidate();
    const below = viewOf(stack.slice(0, index));
    if (below !== undefined) await this.video.pageOpened(below.page).catch(() => undefined);
  }

  /**
   * Pushes a page onto the stack and makes it the view: the attempt's
   * viewport and protocol identity where the transport can be recovered, the
   * next recording segment, then publication with closed entries compacted
   * out. A page that closes during that setup, or a connection that changes
   * under it, rolls back the same way whoever opened the page: the page is
   * closed and the recording resumes on the view it was about to replace.
   */
  private async adopt(page: Page): Promise<PageEntry> {
    const connection = this.connection();
    const view = viewOf(connection.stack);
    this.invalidate();
    const token = this.token();
    const unwound = this.watch(page);
    const closedEarly = () => invalidState('the page closed before it could be entered');
    let recording = false;
    try {
      let target: TargetIdentity | undefined;
      if (connection.contextId !== undefined) {
        await page.setViewportSize(view?.page.viewportSize() ?? this.options.viewport);
        target = await targetIdentity(page);
      }
      this.check(token);
      if (page.isClosed()) throw closedEarly();
      recording = this.video.isArmed;
      await this.video.pageOpened(page);
      this.check(token);
      if (page.isClosed()) throw closedEarly();
      const entry: PageEntry = { page, ...(target === undefined ? {} : { target }), unwound };
      const stack = [...connection.stack.filter((kept) => !kept.page.isClosed()), entry];
      this.state = { kind: 'ready', connection: { ...connection, stack } };
      return entry;
    } catch (cause) {
      await page.close().catch(() => undefined);
      if (recording && this.generation === token && view !== undefined && !view.page.isClosed()) {
        await this.video.pageClosing().catch(() => undefined);
        await this.video.pageOpened(view.page).catch(() => undefined);
      }
      throw cause;
    }
  }

  /** Returns the attempt's active page, opening and adopting one when none is open. */
  async ensurePage(): Promise<Page> {
    const connection = this.connection();
    const view = viewOf(connection.stack);
    if (view !== undefined) return view.page;
    const page = await connection.context.newPage();
    return (await this.adopt(page)).page;
  }

  /**
   * Makes a page the app opened the attempt's active page: the one every
   * query, action, capture, and recording reaches, and a target a CDP
   * recovery looks for. The handle names the page across a reconnect. The
   * page it was entered over is the active page again when the popup closes,
   * whether the test closed it or the app did.
   */
  async enterPopup(popup: Page): Promise<StackedPage> {
    if (viewOf(this.connection().stack) === undefined) throw invalidState('no app page is open; call app.open() or web.goto() first');
    if (popup.isClosed()) throw invalidState('the popup closed before it could be entered');
    return this.adopt(popup);
  }

  /**
   * Closes a popup entered through `enterPopup`: its recording segment ends
   * first, while the page can still flush it, then the page closes and its
   * own unwind is awaited, so the page below is the view once this resolves.
   * A popup already gone (closed by the app, retired by a transition) needs
   * nothing.
   */
  async closePopup(handle: StackedPage): Promise<void> {
    const { stack } = this.connection();
    const entry = stack.find((candidate) => samePage(candidate, handle));
    if (entry === undefined) return;
    if (viewOf(stack) === entry) await this.video.pageClosing();
    if (!entry.page.isClosed()) await entry.page.close();
    await entry.unwound;
  }

  /** Restarts the document while retaining this context's storage. */
  async restart(): Promise<void> {
    const connection = this.connection();
    this.invalidate();
    const token = this.token();
    await this.video.pageClosing();
    const resume = this.video.isArmed ? await this.closeTraceSegment(connection.context) : false;
    // Emptied before the pages close, so their listeners find nothing to unwind.
    this.state = { kind: 'ready', connection: { ...connection, stack: [] } };
    for (const page of connection.context.pages()) await page.close();
    this.check(token);
    await this.ensurePage();
    if (resume) await this.startTrace();
  }

  /** Replaces an ordinary context; persistent recovery never advertises this capability. */
  async replace(storageState: StorageState | undefined, operation: OperationContext): Promise<void> {
    const previous = this.connection();
    const resume = await this.closeTraceSegment(previous.context);
    await this.video.pageClosing();
    await this.transition(previous, operation, async () => {
      await previous.context.close();
      const context = await previous.browser.newContext({ ...this.options.contextOptions, ...(storageState === undefined ? {} : { storageState }) });
      return { browser: previous.browser, context, stack: [] };
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
    const connection = 'connection' in state ? state.connection : undefined;
    if (connection === undefined) return;
    if (this.video.isRecording) await withinCleanupBudget(this.video.pageClosing(), budget);
    if (this.tracing) await withinCleanupBudget(connection.context.tracing.stop(), budget);
    await withinCleanupBudget(this.release(connection), budget);
  }

  /** Ordinary contexts are engine-owned; persistent browser processes belong to the host. */
  private release(connection: Connection): Promise<void> {
    return this.options.persistent === undefined ? connection.context.close() : connection.browser.close();
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
    await this.connection().context.tracing.start(TRACE_OPTIONS);
    this.check(token);
    this.tracing = true;
  }

  /** Returns finalized segments, including any retained before context replacement failed. */
  private async stopTrace(): Promise<string | readonly string[]> {
    const parts = this.traceParts;
    this.traceParts = [];
    if (parts.length > 0 && !this.tracing) return parts;
    const { relative, absolute } = this.tracePath('trace');
    await this.connection().context.tracing.stop({ path: absolute });
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
