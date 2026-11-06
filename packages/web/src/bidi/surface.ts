/**
 * The WebDriver BiDi surface: one browser per worker and one `BidiSession`
 * per attempt, behind the engine hooks and the `browser` fixture calls. Each hook is bounded and classified here and
 * delegates to the module that implements it.
 */

import type { ErrorLatch } from '../support.ts';
import path from 'node:path';
import type { Input, Network, Storage } from 'webdriver-bidi-protocol';
import {
  EngineError,
  raceAbort,
  withTimeout,
  withinCleanupBudget,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type EngineSnapshot,
  type EngineState,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type VideoSegment,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import type { DialogHandler } from '../dialogs.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import { browserCheck, ensureBrowsersInstalled } from '../install.ts';
import type { WebMedia } from '../media.ts';
import { withOperationDeadline } from '../operation-budget.ts';
import { httpCredentials, lowercaseNames, siteHeadersFor } from '../protected-app.ts';
import type { LeasedBrowsers } from '../provider.ts';
import { cancelled, invalidState } from '../support.ts';
import type { WebBasicAuth, WebScreencastOptions } from '../options.ts';
import { perform, performAt, typeInto, typeText } from './actions.ts';
import { screenshot, startVideo, stopVideo } from './artifacts.ts';
import { afterDispatch, classify, releaseQuietly } from './errors.ts';
import { routeEvents, SESSION_EVENTS } from './events.ts';
import { pressSource, SHIFT_KEY } from './input.ts';
import { connectBidiOverCdp, launchBidiBrowser, type BidiBrowser, type BidiBrowserName } from './launch.ts';
import type { NetworkRoute, ObservedResponse } from './network.ts';
import { locate, observe, traceScreen } from './observe.ts';
import { documentTitle } from './page.ts';
import type { PageArgument, PageValue } from './script.ts';
import { BidiSession, ContextOwners, type SessionSettings } from './session.ts';
import { captureState, restoreState } from './state.ts';
import { goto, reload, reset, restart, traverse, type WaitUntil } from './steering.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;
/** How long closing an attempt whose setup failed may take before the browser is retired instead. */
const SETUP_CLEANUP_MS = 15_000;

/** What a BiDi surface is configured with, from `web()`. */
export interface BidiSurfaceOptions {
  readonly browser: BidiBrowserName;
  readonly viewport: ViewportSize | null;
  readonly testIdAttribute: string;
  readonly initScripts: ConfiguredInitScripts;
  readonly screencast: WebScreencastOptions;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly basicAuth: WebBasicAuth | undefined;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  /** The configured media features every attempt starts from. */
  readonly media: WebMedia;
  /** Resolves a remote Chromium's CDP endpoint instead of launching one (`web({ connect })`). */
  readonly cdpEndpoint: ((signal: AbortSignal) => string | Promise<string>) | undefined;
  /** A browser provider's worker-scoped leases, attached to over CDP. */
  readonly leases: LeasedBrowsers | undefined;
}

/**
 * The engine surface on WebDriver BiDi: one browser per worker, one
 * attempt at a time on it, and every engine hook guarded by the operation's
 * budget and the attempt's error latch.
 */
export class BidiSurface {
  private browser: BidiBrowser | undefined;
  /** The endpoint of the browser leased for the running attempt, in a provider's `attempt` scope. */
  private attemptEndpoint: string | undefined;
  private session: BidiSession | undefined;
  private settings: SessionSettings | undefined;
  private headed = false;
  private readonly owners = new ContextOwners();
  private unrouteEvents: () => void = () => undefined;
  /** The launch or attach in flight, which a caller that gave up leaves running and `dispose` waits out. */
  private acquiring: Promise<BidiBrowser> | undefined;
  /** Set by `dispose`: a launch that finishes after it closes its browser instead of publishing it. */
  private disposed = false;

  constructor(private readonly options: BidiSurfaceOptions) {}

  /** Installs the build this driver launches, or leases a provider's browsers, once per run; reads the init scripts. */
  /**
   * The checks of `e2e doctor`: the init scripts `prepare` reads, and the
   * browser, which only a local launch needs on this machine.
   */
  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const scripts = await this.options.initScripts.doctor(info.projectRoot);
    if (this.options.leases !== undefined) return [...scripts, { id: 'browser', status: 'skip', message: `browsers come from the "${this.options.leases.name}" provider` }];
    if (this.options.cdpEndpoint !== undefined) return [...scripts, { id: 'browser', status: 'skip', message: 'the browser is attached over CDP' }];
    return [...scripts, ...(await browserCheck(this.options.browser, info.env, info.headed))];
  }

  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.options.initScripts.load(info.projectRoot);
    if (this.options.leases !== undefined) return this.options.leases.prepare(info);
    if (this.options.cdpEndpoint !== undefined) return;
    await ensureBrowsersInstalled([this.options.browser], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
  }

  /** Releases what `prepare` leased. */
  async finish(info: EngineFinishInfo): Promise<void> {
    await this.options.leases?.finish(info);
  }

  /** Launches or attaches to the worker's browser. */
  async init(info: EngineInitInfo): Promise<void> {
    this.disposed = false;
    this.headed = info.headed;
    const headers = this.options.headers === undefined ? undefined : lowercaseNames(this.options.headers);
    const site = info.app.site;
    this.settings = {
      browser: this.options.browser,
      viewport: this.options.viewport,
      initScripts: this.options.initScripts,
      screencast: this.options.screencast,
      userAgent: this.options.userAgent,
      locale: this.options.locale,
      timezoneId: this.options.timezoneId,
      media: this.options.media,
      testIdAttribute: this.options.testIdAttribute,
      site,
      projectRoot: info.projectRoot,
      permissions: Object.keys(info.app.permissions ?? {}),
      remoteFiles: this.options.leases !== undefined,
      defaultUserContext: this.perAttempt,
      holdRequests: headers !== undefined,
      siteHeaders: (url) => siteHeadersFor(url, site, headers),
    };
    this.options.leases?.init(info);
    await this.options.initScripts.load(info.projectRoot);
    if (!this.perAttempt) await this.acquireBrowser(info.signal);
  }

  /**
   * The live browser, relaunched or reattached when the last one went away;
   * the one that went away is closed first, so a launched browser whose
   * mapper died leaves no process or profile behind. A caller that gives up
   * leaves the launch running, owned by the surface: it publishes the
   * browser, or closes it once the surface was disposed.
   */
  private async acquireBrowser(signal: AbortSignal): Promise<BidiBrowser> {
    if (this.browser !== undefined && !this.browser.connection.isClosed) return this.browser;
    if (signal.aborted) throw cancelled('browser launch cancelled');
    this.acquiring ??= this.launch().finally(() => {
      this.acquiring = undefined;
    });
    return raceAbort(this.acquiring, signal, 'browser launch');
  }

  /** Closes a browser that went away, opens the next, subscribes it, and publishes it unless the surface was disposed meanwhile. */
  private async launch(): Promise<BidiBrowser> {
    const stale = this.browser;
    this.browser = undefined;
    this.unrouteEvents();
    if (stale !== undefined) await releaseQuietly(stale.close());
    const browser = await this.openBrowser(AbortSignal.timeout(BROWSER_LAUNCH_TIMEOUT_MS));
    try {
      await withTimeout(
        browser.connection.send('session.subscribe', { events: [...SESSION_EVENTS] }),
        BROWSER_LAUNCH_TIMEOUT_MS,
        () => new EngineError('OPERATION_TIMEOUT', `the browser did not take its event subscription within ${BROWSER_LAUNCH_TIMEOUT_MS}ms`, { retryable: false }),
      );
      if (this.disposed) throw cancelled('the engine was disposed while its browser launched');
    } catch (cause) {
      await releaseQuietly(browser.close());
      throw cause;
    }
    this.browser = browser;
    this.owners.clear();
    this.unrouteEvents = routeEvents(browser.connection, this.owners, () => this.session);
    return browser;
  }

  /** Whether every attempt leases a fresh browser of its own: a provider's `attempt` scope. */
  private get perAttempt(): boolean {
    return this.options.leases?.scope === 'attempt';
  }

  /** A local launch, or an attach over CDP to the `connect` endpoint, the attempt's lease, or the worker's. */
  private async openBrowser(signal: AbortSignal): Promise<BidiBrowser> {
    const { cdpEndpoint, leases } = this.options;
    if (cdpEndpoint !== undefined) return connectBidiOverCdp(await cdpEndpoint(signal), BROWSER_LAUNCH_TIMEOUT_MS);
    if (this.attemptEndpoint !== undefined) return connectBidiOverCdp(this.attemptEndpoint, BROWSER_LAUNCH_TIMEOUT_MS);
    if (leases !== undefined) return connectBidiOverCdp(await leases.endpoint(signal), BROWSER_LAUNCH_TIMEOUT_MS);
    return launchBidiBrowser(this.options.browser, { headed: this.headed, timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS, firefoxPrefs: firefoxMediaPrefs(this.options.media) });
  }

  /**
   * Opens the attempt's session: its user context, network, downloads, and
   * emulation. A setup that fails or is cancelled is closed at once, and
   * the setup itself is waited out within the same budget (a user context
   * that lands later removes itself); when either cannot finish, or the late
   * removal fails, the browser is retired.
   */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running');
    if (this.settings === undefined) throw invalidState('the engine is not initialized');
    const basicAuth = this.options.basicAuth;
    const credentials = basicAuth === undefined
      ? undefined
      : await raceAbort(() => httpCredentials(basicAuth, context.resolveSecret), context.signal, 'resolving the basic-auth password');
    if (this.perAttempt) {
      const lease = await this.options.leases!.startAttempt(context);
      this.attemptEndpoint = lease.cdpEndpoint;
    }
    let browser: BidiBrowser;
    try {
      browser = await this.acquireBrowser(context.signal);
    } catch (cause) {
      if (this.perAttempt) await this.releaseAttemptBrowser({ signal: AbortSignal.timeout(SETUP_CLEANUP_MS), timeoutMs: SETUP_CLEANUP_MS });
      throw cause;
    }
    const session = new BidiSession(
      browser,
      this.settings,
      { attemptId: context.attemptId, artifactsDir: context.artifactsDir, appLog: context.appLog, navigation: context.navigation, screen: context.screen, credentials, remoteDownloads: this.options.leases?.downloads() },
      this.owners,
    );
    const setup = session.openUserContext();
    try {
      await raceAbort(setup, context.signal, 'attempt setup');
    } catch (cause) {
      const budget = { signal: AbortSignal.timeout(SETUP_CLEANUP_MS), timeoutMs: SETUP_CLEANUP_MS };
      const landed = setup.then(() => ({ failure: undefined }), (late: unknown) => ({ failure: late instanceof EngineError && late.code === 'CANCELLED' ? undefined : late }));
      try {
        await boundedCleanup(session.close(), budget, 'attempt setup cleanup');
        const { failure } = await withTimeout(landed, budget.timeoutMs, () => new EngineError('OPERATION_TIMEOUT', 'attempt setup never settled', { retryable: false }));
        if (failure !== undefined) throw failure;
      } catch {
        await this.retireBrowser(budget);
      }
      if (this.perAttempt) await this.releaseAttemptBrowser(budget);
      throw cause;
    }
    this.session = session;
    context.environment({ browser: `${browser.name} ${browser.version}`, driver: 'webdriver-bidi' });
  }

  /** Waits for a dialog or route handler still running, then rethrows what it latched. */
  async settleAttempt(context: EngineCleanupContext): Promise<void> {
    await this.session?.latch.settle(context);
  }

  /**
   * Ends the attempt's session. Idempotent. A close that fails or outlives
   * the cleanup budget leaves resources the browser may still hold, so the
   * browser is retired (the next attempt launches or attaches afresh) and the
   * failure reported.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    try {
      await boundedCleanup(session.close(), context, 'attempt cleanup');
    } catch (cause) {
      await this.retireBrowser(context);
      throw classify(cause, 'attempt cleanup');
    } finally {
      if (this.perAttempt) await this.releaseAttemptBrowser(context);
    }
  }

  /** Detaches from the attempt's leased browser and gives the lease back; each step attempted whatever the other did. */
  private async releaseAttemptBrowser(context: EngineCleanupContext): Promise<void> {
    this.attemptEndpoint = undefined;
    await releaseQuietly(this.retireBrowser(context));
    await this.options.leases?.endAttempt(context);
  }

  /** Closes the browser, best effort, so the next attempt opens a fresh one. */
  private async retireBrowser(context: EngineCleanupContext): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.unrouteEvents();
    if (browser !== undefined) await withinCleanupBudget(browser.close(), context);
  }

  /** Ends the attempt, closes the browser, and releases a provider's lease, each attempted whatever the others did. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([this.endAttempt(context)]);
    if (this.acquiring !== undefined) await releaseQuietly(withinCleanupBudget(this.acquiring, context));
    const browser = this.browser;
    this.browser = undefined;
    if (browser !== undefined) results.push(...(await Promise.allSettled([boundedCleanup(browser.close(), context, 'browser close')])));
    this.unrouteEvents();
    results.push(...(await Promise.allSettled([this.options.leases?.dispose(context)])));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw classify(failed.reason, 'dispose');
  }

  /** The running attempt; `INVALID_STATE` between attempts. */
  private requireSession(): BidiSession {
    if (this.session === undefined) throw invalidState('no attempt is running');
    return this.session;
  }

  /**
   * Bounds one operation by its budget, fails it with an error a handler
   * latched, and classifies what it threw. An input operation that fails
   * once its input went out may have reached the app
   * (`ACTION_MAY_HAVE_COMMITTED`), so the harness never repeats it blindly;
   * a sensitive value never leaves in a message or a cause. A step that
   * changed the page hands the trace the screen it left.
   */
  private async guard<T>(
    operation: OperationContext,
    label: string,
    work: (session: BidiSession, budget: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<T>,
    kind: { readonly input?: boolean; readonly sensitive?: string; readonly traced?: boolean } = {},
  ): Promise<T> {
    this.session?.latch.throwPending();
    const session = this.session;
    const dispatches = session?.dispatches ?? 0;
    let result: T;
    try {
      result = await withOperationDeadline(operation, label, (remaining) => work(this.requireSession(), remaining()));
    } catch (cause) {
      const dispatched = kind.input === true && session !== undefined && session.dispatches !== dispatches;
      throw afterDispatch(classify(cause, label), label, dispatched, kind.sensitive);
    }
    if (kind.traced === true && session !== undefined) await traceScreen(session, operation.signal);
    return result;
  }

  /** Opens `url` in the attempt's tab, creating it on first use. */
  open(url: string, operation: OperationContext): Promise<void> {
    return this.goto(url, 'load', operation);
  }

  /** Goes back one history entry. */
  back(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => traverse(session, -1, budget.timeoutMs, budget.signal), { traced: true });
  }

  /** Goes forward one history entry. */
  forward(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => traverse(session, 1, budget.timeoutMs, budget.signal), { traced: true });
  }

  /** Closes the tab, keeping the attempt's storage. */
  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'restart', (session) => restart(session));
  }

  /** Starts the attempt over in a clean user context. */
  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', (session) => reset(session));
  }

  /** `browser.goto`: navigates and waits as `waitUntil` says. */
  goto(url: string, waitUntil: WaitUntil, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => goto(session, url, waitUntil, budget.signal), { traced: true });
  }

  /** Reloads the tab. */
  reload(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => reload(session, budget.signal), { traced: true });
  }

  /** One observation of the tab, its frames and, when asked, masked pixels. */
  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    return this.guard(operation, 'observe', (session, budget) => observe(session, budget.timeoutMs, budget.signal, options));
  }

  /** The nodes `expression` matches now, each a ref an action can take. */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(operation, 'locate', (session) => locate(session, expression));
  }

  /** One action on a node, failing as may-have-committed once its input went out. */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, action.kind, (session, budget) => perform(session, ref, action, budget.timeoutMs, budget.signal), {
      input: true,
      traced: true,
      ...(action.kind === 'fill' && action.sensitive ? { sensitive: action.value } : {}),
    });
  }

  /** One pointer action at a viewport point. */
  performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, `${action.kind} at point`, (session, budget) => performAt(session, point, action, budget.signal), { input: true, traced: true });
  }

  /** Types into whatever holds focus. */
  typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.type', (session, budget) => typeText(session, text, options.replace, budget.signal), { input: true, traced: true });
  }

  /** Presses one key of the contract grammar. */
  pressKey(key: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.press', (session, budget) => session.sendInput([pressSource(key)], budget.signal), { input: true, traced: true });
  }

  /** Runs raw input sources from the `browser` fixture; a key or button they press without releasing stays held. */
  input(label: string, actions: Input.SourceActions[], operation: OperationContext): Promise<void> {
    return this.guard(operation, label, (session, budget) => session.sendInput(actions, budget.signal), { input: true });
  }

  /** Types `text` into whatever holds focus, inserting what no key types (`typeInto`). */
  typeKeys(text: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.type', (session, budget) => typeInto(session, text, budget.signal), { input: true });
  }

  /** Where the mouse last moved in the attempt's tab. */
  pointerPosition(): ViewportPoint {
    return this.requireSession().pointer;
  }

  /** The tab's URL. */
  url(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'url', (session) => session.currentUrl());
  }

  /** The tab's document title. */
  title(operation: OperationContext): Promise<string> {
    return this.guard(operation, 'title', (session) => session.run(documentTitle, []));
  }

  /** Calls a compiled page function (`compileEvaluation`) with `arg` and returns its whole result. */
  evaluate(declaration: string, arg: PageArgument | undefined, operation: OperationContext): Promise<PageValue> {
    return this.guard(operation, 'evaluate', (session) => session.call(declaration, arg === undefined ? [] : [arg], { awaitPromise: true, maxObjectDepth: null }));
  }

  /** Runs `source` in every document the attempt opens from now on. */
  addInitScript(source: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'addInitScript', (session) => session.addInitScript(source));
  }

  /** The absolute path of a file a test names relative to the project root. */
  projectPath(file: string): string {
    return path.resolve(this.settings?.projectRoot ?? '', file);
  }

  /** Registers a test route. */
  route(route: NetworkRoute, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'route', (session) => session.network.addRoute(route));
  }

  /** Removes the test routes `match` selects. */
  unroute(match: (route: NetworkRoute) => boolean, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'unroute', async (session) => session.network.removeRoutes(match));
  }

  /** The headers a request to `url` carries for the app's site, which a route's own `fetch` sends too. */
  siteHeaders(url: string): Readonly<Record<string, string>> | undefined {
    return this.settings?.siteHeaders(url);
  }

  /** Whether Shift is held on the attempt's tab, which a key the fixture names by letter is typed in upper case under. */
  shiftHeld(): boolean {
    return this.session?.isHeld(SHIFT_KEY) ?? false;
  }

  /**
   * What a fixture binds to the attempt it serves, once: its latch, its
   * basic-auth credentials, its lifetime, and its cookie jar. A route handler
   * that outlives the attempt then fails, reads, and writes only its own, and
   * its work is cancelled when the attempt closes.
   */
  attemptScope(): AttemptScope {
    const session = this.requireSession();
    return {
      latch: session.latch,
      credentials: session.attempt.credentials,
      lifetime: session.lifetime,
      storeCookies: async (cookies, signal) => {
        const bound = AbortSignal.any([signal, session.lifetime]);
        for (const cookie of cookies) {
          await raceAbort(() => session.connection.send('storage.setCookie', { cookie, partition: session.partition() }), bound, 'route.fetch cookies');
        }
      },
    };
  }


  /** The next response of the tab whose URL `matches`. */
  waitForResponse(matches: (url: string) => boolean, operation: OperationContext): Promise<ObservedResponse> {
    return this.guard(operation, 'waitForResponse', (session, budget) => session.network.waitForResponse(matches, budget.signal));
  }

  /** Registers a dialog handler; returns its unsubscribe. */
  onDialog(handler: DialogHandler): () => void {
    return this.requireSession().dialogs.add(handler);
  }

  /**
   * Runs `trigger` and saves the first `count` downloads it starts into the
   * attempt's `downloads` folder, in start order. The trigger is test code,
   * so only cancellation bounds the wait around it.
   */
  async collectDownloads(count: number, trigger: () => Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<{ path: string; absolutePath: string; suggestedFilename: string }[]> {
    const session = this.requireSession();
    if (this.options.leases !== undefined && session.attempt.remoteDownloads === undefined) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', `browser provider "${this.options.leases.name}" serves no downloads, so a file its remote browser saves cannot be read back`, { retryable: false });
    }
    const finished = await session.downloads.collect(count, trigger, signal, timeoutMs, (context) => session.onPage(context));
    const saved: { path: string; absolutePath: string; suggestedFilename: string }[] = [];
    for (const download of finished) {
      const { relative, absolute } = session.artifactPath('downloads', download.suggestedFilename, '');
      await session.downloads.save(download, absolute, signal);
      saved.push({ path: relative, absolutePath: absolute, suggestedFilename: download.suggestedFilename });
    }
    return saved;
  }

  /**
   * Changes the attempt's media features from the next paint on. Firefox
   * overrides only `prefers-color-scheme` over BiDi, so a reduced-motion
   * change refuses there; `web({ reducedMotion })` still applies at launch.
   */
  emulateMedia(media: WebMedia, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'emulateMedia', async (session) => {
      if (this.options.browser === 'firefox' && media.reducedMotion !== undefined) {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'browser.emulateMedia({ reducedMotion }) is not supported on Firefox, which overrides only prefers-color-scheme over WebDriver BiDi; set web({ reducedMotion }) instead', { retryable: false });
      }
      session.media = { ...session.media, ...media };
      await session.applyMedia();
    });
  }

  /** The attempt's cookies. */
  cookies(operation: OperationContext): Promise<Network.Cookie[]> {
    return this.guard(operation, 'cookies', async (session) => (await session.connection.send('storage.getCookies', { partition: session.partition() })).cookies);
  }

  /** Stores cookies in the attempt's user context. */
  setCookies(cookies: readonly Storage.PartialCookie[], operation: OperationContext): Promise<void> {
    return this.guard(operation, 'setCookies', async (session) => {
      for (const cookie of cookies) await session.connection.send('storage.setCookie', { cookie, partition: session.partition() });
    });
  }

  /** Deletes the cookies each filter selects; an empty filter selects every one. */
  deleteCookies(filters: readonly Storage.CookieFilter[], operation: OperationContext): Promise<void> {
    return this.guard(operation, 'clearCookies', async (session) => {
      for (const filter of filters) await session.connection.send('storage.deleteCookies', { filter, partition: session.partition() });
    });
  }

  /** Resizes the tab, and every tab the attempt opens after. */
  setViewport(size: ViewportSize, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'setViewport', (session) => session.setViewport(size));
  }

  /** Sets the viewport for the agent's `resize` verb, as `browser.setViewport` does, and shows the screen after it. */
  resize(size: ViewportSize, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'resize', (session) => session.setViewport(size), { traced: true });
  }

  /** The attempt's saved-session state. */
  captureState(operation: OperationContext): Promise<EngineState> {
    return this.guard(operation, 'state capture', (session) => captureState(session));
  }

  /** Replaces the attempt's storage with a saved session's. */
  restoreState(state: EngineState, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state restore', (session) => restoreState(session, state));
  }

  /** A masked viewport screenshot, saved under the attempt directory. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', (session, budget) => screenshot(session, label, budget.signal));
  }

  /** Starts the attempt's video: the provider's recording when it records, else the driver's own. */
  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', (session, budget) => startVideo(session, this.options.leases?.recorder(session.attempt.attemptId), budget.signal));
  }

  /** Ends the attempt's video and returns its segments. */
  stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    return this.guard(operation, 'video', (session, budget) => stopVideo(session, budget.signal));
  }
}

/** What `attemptScope` binds: the attempt's own latch, credentials, lifetime, and cookie jar. */
export interface AttemptScope {
  readonly latch: ErrorLatch;
  readonly credentials: { readonly username: string; readonly password: string } | undefined;
  /** Aborts when the attempt closes. */
  readonly lifetime: AbortSignal;
  /** Stores cookies in the attempt's jar, giving up once `signal` aborts or the attempt closes. */
  storeCookies(cookies: readonly Storage.PartialCookie[], signal: AbortSignal): Promise<void>;
}

/**
 * Waits for a cleanup step within the cleanup budget, keeping its failure:
 * one that outlives the budget fails as `OPERATION_TIMEOUT`, one cancelled
 * as `CANCELLED`.
 */
function boundedCleanup(work: Promise<unknown>, budget: EngineCleanupContext, label: string): Promise<void> {
  return withTimeout(
    raceAbort(work.then(() => undefined), budget.signal, label),
    budget.timeoutMs,
    () => new EngineError('OPERATION_TIMEOUT', `${label} did not finish within ${budget.timeoutMs}ms`, { retryable: false }),
  );
}

/** Firefox preferences that set the configured media features for every page, since Firefox before 159 has no BiDi media override. */
function firefoxMediaPrefs(media: WebMedia): Record<string, number> {
  const prefs: Record<string, number> = {};
  if (media.colorScheme !== undefined) {
    prefs['layout.css.prefers-color-scheme.content-override'] = media.colorScheme === 'dark' ? 0 : media.colorScheme === 'light' ? 1 : 2;
  }
  if (media.reducedMotion !== undefined) prefs['ui.prefersReducedMotion'] = media.reducedMotion === 'reduce' ? 1 : 0;
  return prefs;
}
