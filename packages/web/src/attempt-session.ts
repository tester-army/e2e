/** Owns one attempt's live binding, its tabs, recovery, references, and recordings. */
import type { Browser, BrowserContext, BrowserContextOptions, Page, Request } from 'playwright-core';
import { EngineError, raceAbort, TestError, withinCleanupBudget, type EngineCleanupContext, type OperationContext, type VideoSegment, type ViewportSize } from 'e2e/engine';
import { attachPersistent, recoveryFailed, targetIdentity, type CdpEndpointResolver, type SessionBinding, type TargetIdentity } from './cdp-recovery.ts';
import { connectionAbort, withConnectionBudget, withOperationDeadline, type ConnectionBudget, type OperationBound } from './operation-budget.ts';
import { RefRegistry } from './refs.ts';
import type { LeaseRecording } from './provider.ts';
import { ProviderVideo } from './provider-video.ts';
import type { WebMedia } from './media.ts';
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
  /** The media features every page the attempt opens emulates, until `emulateMedia` changes them. */
  readonly media: WebMedia;
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

/**
 * One tab of the attempt: the attempt's own page, a tab the app opened from
 * one of the attempt's tabs (a `target="_blank"` link, `window.open`), or one
 * a test opened. The object outlives a CDP reconnect, which hands it the
 * page of the same target on the new connection.
 */
export interface AttemptTab {
  page: Page;
  /** The tab it was opened from; undefined for the attempt's own page, a tab a test opened, and one whose opener closed before it loaded. */
  readonly opener: AttemptTab | undefined;
  /** The page's CDP target on a persistent browser, which a reconnect finds it by. */
  target: TargetIdentity | undefined;
  /** When the tab was last shown, in the attempt's order; 0 for never. */
  shownAt: number;
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
  /** Settles when the latest observation in line has finished; never rejects. */
  private observing: Promise<void> = Promise.resolve();
  /** Until the attempt's first page opens: a persistent browser's own first tab can serve as that page. */
  private firstPage = true;
  private requestedViewport: { readonly width: number; readonly height: number } | undefined;
  private media: WebMedia;
  /** The emulation each page got as it appeared, so the attempt's own page is ready before it shows. */
  private readonly emulated = new WeakMap<Page, Promise<void>>();
  /** The active page being opened for the current binding, shared by concurrent callers. */
  private pendingPage: { readonly binding: SessionBinding; readonly work: Promise<Page> } | undefined;
  /** The attempt's open tabs, in the order they opened; the binding's page is the one shown. */
  private tabs: AttemptTab[] = [];
  /** How many times a tab was shown, for `AttemptTab.shownAt`. */
  private shown = 0;
  /**
   * Tab changes in the order they happened: following a tab the app opened,
   * showing another, returning from one that closed. Settles once the last
   * has finished; never rejects. Every operation waits for it first.
   */
  private tabWork: Promise<void> = Promise.resolve();
  /** Waiting for the next tab the app opens (`browser.waitForPopup`), each told the tab and the work that shows it. */
  private readonly popupWaiters = new Set<(tab: AttemptTab, shown: Promise<void>) => void>();
  /** Pages the attempt is opening itself (its own page, `newTab`); every other page of its context is one the app opened. */
  private readonly creating = new Set<Promise<Page>>();
  private readonly ownPages = new WeakSet<Page>();
  /** Pages the app opened that are already joining the tabs, from their opener's `popup` or as an orphan. */
  private readonly claimed = new WeakSet<Page>();

  constructor(private readonly options: SessionOptions) {
    this.media = options.media;
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

  /**
   * Runs one observation after every earlier one has finished, so each
   * publishes its references in turn instead of the later one superseding a
   * capture still in flight. Time spent waiting comes out of the operation's.
   */
  async observeInTurn<T>(operation: OperationContext, capture: (operation: OperationContext) => Promise<T>): Promise<T> {
    const queued = Date.now();
    const before = this.observing;
    let finished!: () => void;
    const mine = new Promise<void>((resolve) => { finished = resolve; });
    this.observing = before.then(() => mine);
    try {
      await raceAbort(before, operation.signal, 'observe');
      return await capture({ ...operation, timeoutMs: Math.max(1, operation.timeoutMs - (Date.now() - queued)) });
    } finally {
      finished();
    }
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
    // A tab change already queued (a tab that closed, one a test showed) lands
    // before the operation reads or acts on one, within the operation's own time.
    const settling = endsAt - Date.now();
    if (settling > 0) await withConnectionBudget({ signal, timeoutMs: settling }, label, () => this.tabWork);
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
        this.watchPages(candidate.context);
        if (recover) await this.remapTabs(candidate);
        if (recover && candidate.page !== null) {
          const size = previous?.page?.viewportSize() ?? this.requestedViewport ?? this.options.viewport;
          if (size !== null) await candidate.page.setViewportSize(size);
          // Emulation belongs to the CDP session that set it, so the new transport sets it again, on the app's own tabs too.
          await this.applyMedia(candidate.page);
          await this.emulateOnOthers(candidate.context, candidate.page, (page) => this.applyMedia(page));
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

  /** Opens the active page once; concurrent callers share it. */
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
      await (this.emulated.get(page) ?? this.applyMedia(page));
      if (identity !== undefined) identity = { ...identity, target: await targetIdentity(page) };
      this.check(token);
      await this.video.pageOpened(page);
      this.check(token);
      this.state = { kind: 'ready', binding: { ...binding, page, ...(identity === undefined ? {} : { identity }) } };
      this.adopt(page, undefined, identity?.target).shownAt = ++this.shown;
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
    return this.createPage(context);
  }

  /** Opens a page of the attempt's own, which never counts as a tab the app opened. */
  private createPage(context: BrowserContext): Promise<Page> {
    const creating = context.newPage().then((page) => {
      this.ownPages.add(page);
      return page;
    });
    this.creating.add(creating);
    creating.then(() => { this.creating.delete(creating); }, () => { this.creating.delete(creating); });
    return creating;
  }

  // --- tabs ---

  /** The attempt's open tabs, in the order they opened. */
  openTabs(): readonly AttemptTab[] {
    return this.tabs;
  }

  /** The tab the attempt shows, if a page is open. */
  shownTab(): AttemptTab | undefined {
    const page = this.state.kind === 'ready' ? this.state.binding.page : null;
    return page === null ? undefined : this.tabs.find((tab) => tab.page === page);
  }

  /** Shows one open tab: every read and action from now on is on its page. */
  async showTab(tab: AttemptTab): Promise<void> {
    const open = (): void => {
      if (!this.tabs.includes(tab) || tab.page.isClosed()) throw new TestError('ACTION_FAILED', 'the tab is closed');
    };
    open();
    // Checked again in turn: a change queued before this one may be the tab closing.
    await this.inTurn(async () => {
      open();
      await this.show(tab);
    }, true);
  }

  /** Shows the open tab at `index` in opening order, as the agent's `switchTab` counts them. */
  showTabAt(index: number): Promise<void> {
    return this.showTab(this.tabAt(index));
  }

  /** Closes the open tab at `index` in opening order, as the agent's `closeTab` counts them; the last open tab stays. */
  async closeTabAt(index: number): Promise<void> {
    const tab = this.tabAt(index);
    const lastOpen = (): boolean => this.tabs.every((other) => other === tab || other.page.isClosed());
    if (lastOpen()) throw new TestError('ACTION_FAILED', `tab ${String(index + 1)} is the only open tab`);
    // Checked again in turn: a change queued before this one may be another tab closing.
    await this.inTurn(async () => {
      if (lastOpen()) throw new TestError('ACTION_FAILED', `tab ${String(index + 1)} is the only open tab`);
      if (!tab.page.isClosed()) await tab.page.close();
    }, true);
    await this.tabsSettled();
  }

  /** The open tab at `index` in opening order, or an `ACTION_FAILED` the model reads. */
  private tabAt(index: number): AttemptTab {
    const tab = this.tabs[index];
    if (!Number.isSafeInteger(index) || tab === undefined) {
      const open = this.tabs.length;
      throw new TestError('ACTION_FAILED', `there is no tab ${String(index + 1)}: ${String(open)} tab${open === 1 ? ' is' : 's are'} open`);
    }
    return tab;
  }

  /** Opens a new tab in the attempt's context, as a test asks, and shows it. */
  async newTab(): Promise<AttemptTab> {
    const page = await this.createPage(this.current().context);
    const tab = this.adopt(page, undefined, undefined);
    try {
      await this.inTurn(() => this.show(tab), true);
    } catch (cause) {
      // Closed as a tab, so a screen already moved to it moves back.
      await page.close().catch(() => undefined);
      await this.tabsSettled();
      throw cause;
    }
    return tab;
  }

  /** Closes a tab; when it was the one shown, waits until the tab shown next is. */
  async closeTab(tab: AttemptTab): Promise<void> {
    if (!tab.page.isClosed()) await tab.page.close();
    await this.tabsSettled();
  }

  /** Whether `page` closed as a tab does, with the browser still connected, rather than with the connection. */
  tabClosed(page: Page): boolean {
    return page.isClosed() && this.state.kind === 'ready' && this.state.binding.browser.isConnected();
  }

  /** Settles once every tab change queued so far has finished. */
  tabsSettled(): Promise<void> {
    return this.tabWork;
  }

  /**
   * Waits for the next tab the app opens and shows it: `opened` resolves
   * with the tab once it is shown, or with it closed when the app closed it
   * first. `loading` names the page a tab is still loading meanwhile, which
   * the browser has not reported as a tab yet, for a wait that times out.
   */
  nextPopup(signal: AbortSignal): { readonly opened: Promise<AttemptTab>; readonly loading: () => string | undefined } {
    let waiter!: (tab: AttemptTab, shown: Promise<void>) => void;
    const opened = new Promise<AttemptTab>((resolve) => {
      waiter = (tab, shown) => {
        this.popupWaiters.delete(waiter);
        resolve(shown.then(() => tab));
      };
    });
    this.popupWaiters.add(waiter);
    const loading = new Set<Request>();
    const started = (request: Request): void => { if (opensTab(request)) loading.add(request); };
    const ended = (request: Request): void => { loading.delete(request); };
    const answered = (response: { request(): Request }): void => { ended(response.request()); };
    const { context } = this.current();
    context.on('request', started);
    context.on('response', answered);
    context.on('requestfailed', ended);
    const forget = () => {
      this.popupWaiters.delete(waiter);
      context.off('request', started);
      context.off('response', answered);
      context.off('requestfailed', ended);
    };
    signal.addEventListener('abort', forget, { once: true });
    return {
      opened: raceAbort(opened, signal, 'popup').finally(() => {
        forget();
        signal.removeEventListener('abort', forget);
      }),
      loading: () => [...loading].at(-1)?.url(),
    };
  }

  /** Records a page as one of the attempt's tabs and watches it for the tabs it opens and for its own close. */
  private adopt(page: Page, opener: AttemptTab | undefined, target: TargetIdentity | undefined): AttemptTab {
    const tab: AttemptTab = { page, opener, target, shownAt: 0 };
    this.tabs.push(tab);
    this.watchTab(tab);
    return tab;
  }

  /** Listens on the tab's current page; a page a reconnect replaced stops counting for it. */
  private watchTab(tab: AttemptTab): void {
    const page = tab.page;
    page.on('popup', (popup) => { this.follow(popup, tab, page); });
    page.once('close', () => { this.closed(tab, page); });
  }

  /** A tab the app opened from one of the attempt's tabs joins the tabs. */
  private follow(popup: Page, opener: AttemptTab, from: Page): void {
    if (opener.page !== from || !this.tabs.includes(opener)) return;
    this.claimed.add(popup);
    this.join(popup, opener);
  }

  /**
   * A page of the attempt's context that neither the attempt opened nor a
   * tab heard open: one whose opener closed before Playwright reported it,
   * such as a window that opens the next one and closes itself. When the
   * browser says a page opened it, it joins the tabs like any tab the app
   * opens; a page something else opened in the context does not. Read once
   * the attempt's own pages being opened are known, and a turn after the
   * `popup` event, which Playwright emits right after the context's `page`.
   */
  private orphaned(page: Page): void {
    const unclaimed = (): boolean => !this.ownPages.has(page) && !this.claimed.has(page);
    void Promise.allSettled(this.creating).then(() => {
      setImmediate(() => {
        if (!unclaimed()) return;
        targetIdentity(page).then((target) => {
          if (target.openerId === undefined || !unclaimed()) return;
          this.claimed.add(page);
          this.join(page, undefined, target);
        }, () => {
          // No CDP to ask (Firefox, WebKit): a page the attempt did not open is taken as the app's.
          if (!unclaimed()) return;
          this.claimed.add(page);
          this.join(page, undefined);
        });
      });
    });
  }

  /**
   * Adds a page the app opened to the tabs once it has a document. It stays
   * in the background, as the attempt's screen stays on its tab, unless
   * `browser.waitForPopup` is waiting for it: then it is shown.
   */
  private join(popup: Page, opener: AttemptTab | undefined, target?: TargetIdentity): void {
    if (this.state.kind === 'pending') {
      // A reconnect is publishing the binding the page belongs to: join it then.
      this.state.work.then(() => { this.join(popup, opener, target); }, () => undefined);
      return;
    }
    if (this.state.kind !== 'ready' || popup.isClosed() || this.tabs.some((tab) => tab.page === popup)) return;
    if (popup.url() === '') {
      // No document committed yet: a link whose response was a download
      // leaves its tab so, where a person's browser closes it. It joins the
      // tabs only once a document commits.
      const committed = (): void => {
        if (popup.url() === '') return;
        popup.off('framenavigated', committed);
        this.join(popup, opener, target);
      };
      popup.on('framenavigated', committed);
      return;
    }
    if (this.state.binding.identity !== undefined && target === undefined) {
      // A reconnect finds each tab by its target, a tab in the background too, so a tab joins with it.
      targetIdentity(popup).then((read) => { this.join(popup, opener, read); }, () => undefined);
      return;
    }
    const tab = this.adopt(popup, opener, target);
    if (this.popupWaiters.size === 0) return;
    const shown = this.inTurn(() => this.show(tab));
    for (const waiter of this.popupWaiters) waiter(tab, shown);
  }

  /**
   * A tab's page closed. When it was the one shown, its opener is shown
   * next, else the open tab shown most recently. A page a dropped connection
   * closed is no tab closing: the close is read a turn later, once the
   * browser says whether it is still connected, and recovery keeps the tab.
   */
  private closed(tab: AttemptTab, page: Page): void {
    setImmediate(() => {
      const binding = this.state.kind === 'ready' ? this.state.binding : undefined;
      if (tab.page !== page || !this.tabs.includes(tab) || binding === undefined || !binding.browser.isConnected()) return;
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      if (binding.page !== page) return;
      const next = this.returnTo(tab);
      if (next === undefined) {
        this.invalidate();
        this.state = { kind: 'ready', binding: { ...binding, page: null } };
      } else {
        this.publish(binding, next);
      }
      void this.inTurn(async () => {
        await this.video.pageClosed();
        if (next === undefined || this.shownTab() !== next) return;
        if (this.requestedViewport !== undefined) await next.page.setViewportSize(this.requestedViewport);
        await this.video.pageOpened(next.page);
      });
    });
    // Queued now, so an operation that starts before the close is read waits for it.
    void this.inTurn(() => new Promise<void>((resolve) => { setImmediate(() => { setImmediate(resolve); }); }));
  }

  /** The tab shown when `closed` closes: its nearest open opener, else the open tab shown most recently. */
  private returnTo(closed: AttemptTab): AttemptTab | undefined {
    for (let opener = closed.opener; opener !== undefined; opener = opener.opener) {
      if (this.tabs.includes(opener)) return opener;
    }
    return this.tabs.reduce<AttemptTab | undefined>((best, tab) => (best === undefined || tab.shownAt > best.shownAt ? tab : best), undefined);
  }

  /**
   * Shows a tab once its page is set up as the attempt's own is: the
   * viewport a test asked for, the media features, its target on a
   * persistent browser. Then the recording moves to it.
   */
  private async show(tab: AttemptTab): Promise<void> {
    const binding = this.current();
    if (binding.page === tab.page) return;
    const page = tab.page;
    const size = this.requestedViewport ?? (binding.identity === undefined ? null : this.options.viewport);
    if (size !== null) await page.setViewportSize(size);
    await (this.emulated.get(page) ?? this.applyMedia(page));
    if (binding.identity !== undefined) tab.target ??= await targetIdentity(page);
    const now = this.state.kind === 'ready' ? this.state.binding : undefined;
    if (now?.context !== binding.context || !this.tabs.includes(tab) || page.isClosed()) return;
    this.publish(now, tab);
    await this.video.pageOpened(page);
  }

  /** Makes `tab` the binding's page: every reference and read in flight belongs to the page shown before. */
  private publish(binding: SessionBinding, tab: AttemptTab): void {
    this.invalidate();
    tab.shownAt = ++this.shown;
    const identity = binding.identity === undefined
      ? undefined
      : { contextId: binding.identity.contextId, ...(tab.target === undefined ? {} : { target: tab.target }) };
    this.state = { kind: 'ready', binding: { ...binding, page: tab.page, ...(identity === undefined ? {} : { identity }) } };
  }

  /**
   * Queues one tab change behind the earlier ones. The queue never rejects;
   * `rethrow` hands this change's own failure to its caller, and a change
   * nobody awaits fails quietly, as a tab the app opened cannot fail a step.
   */
  private inTurn(work: () => Promise<void>, rethrow = false): Promise<void> {
    const run = this.tabWork.then(work);
    this.tabWork = run.catch(() => undefined);
    return rethrow ? run : run.catch(() => undefined);
  }

  /**
   * After a reconnect, finds each tab's page on the new connection by its
   * target and listens there; a tab whose target is gone is closed.
   */
  private async remapTabs(candidate: SessionBinding): Promise<void> {
    const byTarget = new Map<string, Page>();
    for (const page of candidate.context.pages()) byTarget.set((await targetIdentity(page)).targetId, page);
    this.tabs = this.tabs.filter((tab) => {
      const page = tab.target === undefined ? undefined : byTarget.get(tab.target.targetId);
      if (page === undefined) return false;
      tab.page = page;
      this.watchTab(tab);
      return true;
    });
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

  /**
   * Emulates media features on every open tab and every tab opened after
   * them, the app's own included; a feature `media` leaves out keeps its value.
   */
  async emulateMedia(media: WebMedia): Promise<void> {
    // Merged before the await, so a second call made meanwhile builds on this one instead of the old value.
    this.media = { ...this.media, ...media };
    const { context, page } = this.current();
    if (page !== null && !page.isClosed()) await page.emulateMedia(this.media);
    await this.emulateOnOthers(context, page, (other) => other.emulateMedia(this.media));
  }

  /**
   * Runs `emulate` on every open tab but the attempt's own. A tab the app
   * closes meanwhile fails its own call only; an error on a tab still open
   * propagates.
   */
  private async emulateOnOthers(context: BrowserContext, own: Page | null, emulate: (page: Page) => Promise<void>): Promise<void> {
    const others = context.pages().filter((page) => page !== own && !page.isClosed());
    await Promise.all(others.map(async (page) => {
      try {
        await emulate(page);
      } catch (cause) {
        if (!page.isClosed()) throw cause;
      }
    }));
  }

  /** Sets the attempt's media features on a page before it shows anything; a page with none set keeps the browser's own. */
  private async applyMedia(page: Page): Promise<void> {
    if (Object.keys(this.media).length > 0) await page.emulateMedia(this.media);
  }

  /**
   * Emulates the attempt's media on each tab as it appears, so a tab the app
   * opens itself follows a test's change too, on a persistent context as
   * well, where the engine sets no context options. Playwright emulates per
   * page, so a test's change reaches it once it exists: its scripts may read
   * the context's configured values until then. A tab the attempt opens
   * awaits the same work in `ensurePage`; a tab the app opens is not awaited.
   */
  private watchPages(context: BrowserContext): void {
    context.on('page', (page) => {
      const applied = this.applyMedia(page);
      this.emulated.set(page, applied);
      applied.catch(() => undefined);
      this.orphaned(page);
    });
  }

  /** Restarts the document while retaining this context's storage. */
  async restart(): Promise<void> {
    const binding = this.current();
    this.invalidate();
    const token = this.token();
    await this.video.pageClosing();
    this.tabs = [];
    for (const page of binding.context.pages()) await page.close();
    this.check(token);
    this.state = { kind: 'ready', binding: { ...binding, page: null } };
    await this.ensurePage();
  }

  /** Replaces an ordinary context; persistent recovery never advertises this capability. */
  async replace(storageState: StorageState | undefined, operation: OperationContext): Promise<void> {
    const previous = this.current();
    await this.video.pageClosing();
    this.tabs = [];
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
    this.tabs = [];
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

/**
 * The first request of a tab being opened: a navigation Playwright has no
 * frame for yet, since the page it loads in is not reported.
 */
function opensTab(request: Request): boolean {
  if (!request.isNavigationRequest() || !/^https?:/.test(request.url())) return false;
  try {
    request.frame();
    return false;
  } catch {
    return true;
  }
}
