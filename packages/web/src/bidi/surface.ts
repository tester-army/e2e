/**
 * The WebDriver BiDi surface: one browser per worker (or per attempt) and
 * one `BidiSession` per attempt, behind the engine hooks and the `browser` fixture calls. Each hook is bounded and classified here and
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
import type { WebMedia } from '../media.ts';
import { withDeadline } from '../operation-budget.ts';
import { httpCredentials, lowercaseNames, siteHeadersFor } from '../protected-app.ts';
import { cancelled, invalidState } from '../support.ts';
import type { WebBasicAuth, WebScreencastOptions } from '../options.ts';
import { perform, performAt, typeInto, typeText } from './actions.ts';
import { screenshot, startVideo, stopVideo } from './artifacts.ts';
import { DispatchScope } from './bidi-input.ts';
import { afterDispatch, classify, releaseQuietly } from './errors.ts';
import { BROWSER_OPEN_TIMEOUT_MS, BrowserHandle, type BrowserSource } from './browser-source.ts';
import { fixtureKeyStroke, type KeyPhase } from './keyboard.ts';
import type { NetworkRoute } from './network.ts';
import type { ObservedResponse } from './network-binding.ts';
import { locate, observe, traceScreen } from './observe.ts';
import { documentTitle } from './page.ts';
import type { PageArgument, PageValue } from './script.ts';
import { BidiSession, type SessionSettings } from './session.ts';
import { captureState, restoreState } from './state.ts';
import { goto, reload, reset, restart, traverse, type WaitUntil } from './steering.ts';

/** What a BiDi surface is configured with, from `web()`. */
export interface BidiSurfaceOptions {
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
  /** Where the browser comes from. */
  readonly source: BrowserSource;
}

/** A browser being opened, which the next caller joins and `endAttempt` or `dispose` cancels. */
interface Acquisition {
  readonly controller: AbortController;
  readonly handle: Promise<BrowserHandle>;
}

/**
 * The engine surface on WebDriver BiDi: one browser per worker (or per
 * attempt, as the source says), one attempt at a time on it, and every
 * engine hook guarded by the operation's budget and the attempt's error
 * latch.
 */
export class BidiSurface {
  /** The browser the worker, or in `attempt` scope the running attempt, rides. */
  private handle: BrowserHandle | undefined;
  private acquiring: Acquisition | undefined;
  private session: BidiSession | undefined;
  private settings: SessionSettings | undefined;
  /**
   * Aborted by `dispose`: a browser still being opened fails `CANCELLED`, and
   * one that opens after it is closed instead of published. Replaced by
   * `init`.
   */
  private disposal = new AbortController();

  constructor(private readonly options: BidiSurfaceOptions) {}

  /** The checks of `e2e doctor`: the init scripts `prepare` reads, and what the browser source needs on this machine. */
  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const scripts = await this.options.initScripts.doctor(info.projectRoot);
    return [...scripts, ...(await this.options.source.doctor(info))];
  }

  /** Reads the init scripts and has the source provision the run's browsers, once per run. */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.options.initScripts.load(info.projectRoot);
    return this.options.source.prepare(info);
  }

  /** Releases what `prepare` provisioned. */
  finish(info: EngineFinishInfo): Promise<void> {
    return this.options.source.finish(info);
  }

  /**
   * Records the run and, in `worker` scope, opens the worker's browser. A
   * new tenure: a browser an earlier init was still opening is cancelled,
   * and one it left open is closed, so nothing it opened is reused.
   */
  async init(info: EngineInitInfo): Promise<void> {
    this.disposal.abort();
    this.disposal = new AbortController();
    this.acquiring = undefined;
    const stale = this.handle;
    this.handle = undefined;
    if (stale !== undefined) await releaseQuietly(stale.close());
    const { source } = this.options;
    const headers = this.options.headers === undefined ? undefined : lowercaseNames(this.options.headers);
    const site = info.app.site;
    this.settings = {
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
      remoteFiles: source.files === 'remote',
      userContext: source.userContext,
      env: info.env,
      holdRequests: headers !== undefined,
      siteHeaders: (url) => siteHeadersFor(url, site, headers),
    };
    source.init(info);
    await this.options.initScripts.load(info.projectRoot);
    if (source.scope === 'worker') await this.browserFor(info.signal);
  }

  /**
   * The worker's live browser, opened when there is none or the last one
   * went away; in `attempt` scope (`attempt` given) always a fresh one for
   * the attempt. A caller joins the worker's opening in flight, and its
   * `signal` bounds only its own wait, so a browser a caller gave up on
   * still opens and is published for the next one; an attempt's opening is
   * the attempt's alone.
   */
  private async browserFor(signal: AbortSignal, attempt?: EngineAttemptContext): Promise<BrowserHandle> {
    if (attempt === undefined && this.handle?.alive === true) return this.handle;
    const verb = this.options.source.kind === 'launch' ? 'launch' : 'connect';
    if (signal.aborted) throw cancelled(`browser ${verb} cancelled`);
    const acquiring = attempt === undefined ? (this.acquiring ?? this.acquire(undefined)) : this.acquire(attempt);
    try {
      return await raceAbort(acquiring.handle, signal, `browser ${verb}`);
    } catch (cause) {
      throw classify(cause, `browser ${verb} failed`);
    }
  }

  /**
   * Opens a browser in the background: the one that went away is closed
   * first, so a launched browser whose mapper died leaves no process or
   * profile behind. The opening ends `CANCELLED` once the surface is
   * disposed, its attempt ends, or (in `attempt` scope) the attempt's signal
   * aborts; a worker's opening is also bounded by `BROWSER_OPEN_TIMEOUT_MS`.
   * It publishes the browser unless it was cancelled by then.
   */
  private acquire(attempt: EngineAttemptContext | undefined): Acquisition {
    this.acquiring?.controller.abort();
    const controller = new AbortController();
    const timeout = new AbortController();
    const timer = attempt === undefined
      ? setTimeout(() => timeout.abort(new EngineError('OPERATION_TIMEOUT', `the browser did not open within ${BROWSER_OPEN_TIMEOUT_MS}ms`, { retryable: false })), BROWSER_OPEN_TIMEOUT_MS)
      : undefined;
    const signal = AbortSignal.any([controller.signal, this.disposal.signal, timeout.signal, ...(attempt === undefined ? [] : [attempt.signal])]);
    const stale = this.handle;
    this.handle = undefined;
    const acquisition: Acquisition = {
      controller,
      handle: (async () => {
        if (stale !== undefined) await releaseQuietly(stale.close());
        const browser = await this.options.source.open({ signal, attempt });
        const handle = await BrowserHandle.open(browser, () => this.session, signal);
        this.handle = handle;
        return handle;
      })().finally(() => {
        clearTimeout(timer);
        if (this.acquiring === acquisition) this.acquiring = undefined;
      }),
    };
    this.acquiring = acquisition;
    return acquisition;
  }

  /**
   * Opens the attempt's session on the browser and sets up its user
   * context, network, downloads, and emulation. The session is the
   * attempt's from the start, so `endAttempt`, which the harness runs after
   * a failed start too, tears down whatever the setup reached; a user
   * context that lands after the attempt ended removes itself.
   */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running');
    const settings = this.settings;
    if (settings === undefined) throw invalidState('the engine is not initialized');
    const { source } = this.options;
    const basicAuth = this.options.basicAuth;
    const credentials = basicAuth === undefined
      ? undefined
      : await raceAbort(() => httpCredentials(basicAuth, context.resolveSecret), context.signal, 'resolving the basic-auth password');
    const signal = AbortSignal.any([context.signal, this.disposal.signal]);
    let handle: BrowserHandle;
    try {
      handle = await this.browserFor(signal, source.scope === 'attempt' ? { ...context, signal } : undefined);
    } catch (cause) {
      throw source.scope === 'attempt' ? classify(cause, 'attaching to the leased browser') : cause;
    }
    const session = new BidiSession(
      handle.browser,
      settings,
      {
        attemptId: context.attemptId,
        artifactsDir: context.artifactsDir,
        appLog: context.appLog,
        navigation: context.navigation,
        screen: context.screen,
        credentials,
        remoteDownloads: source.downloads(),
      },
      handle.contexts,
    );
    this.session = session;
    try {
      await raceAbort(session.openUserContext(signal), context.signal, 'attempt setup');
    } catch (cause) {
      throw classify(cause, 'attempt setup');
    }
    context.environment({ browser: `${handle.browser.traits.name} ${handle.browser.version}`, driver: 'webdriver-bidi' });
  }

  /** Waits for a dialog or route handler still running, then rethrows what it latched. */
  async settleAttempt(context: EngineCleanupContext): Promise<void> {
    await this.session?.latch.settle(context);
  }

  /**
   * Ends the attempt's session, also after a failed `startAttempt`.
   * Idempotent. A close that fails or outlives the cleanup budget leaves
   * resources the browser may still hold, so the browser is retired (the
   * next attempt opens a fresh one) and the failure reported. In `attempt`
   * scope the attempt's browser is closed and given back on every path.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const session = this.session;
    this.session = undefined;
    const { source } = this.options;
    try {
      if (session !== undefined) {
        try {
          await boundedCleanup(session.close(), context, 'attempt cleanup');
        } catch (cause) {
          await this.retireBrowser(context);
          throw classify(cause, 'attempt cleanup');
        }
      }
    } finally {
      if (source.scope === 'attempt') {
        await this.retireBrowser(context);
        await source.endAttempt(context);
      }
    }
  }

  /**
   * Closes the browser within the cleanup budget, best effort, so the next
   * attempt opens a fresh one. In `attempt` scope an opening still in flight
   * is the ending attempt's, so it is cancelled: a browser it opens after
   * closes itself, and a lease it gets is given back.
   */
  private async retireBrowser(context: EngineCleanupContext): Promise<void> {
    if (this.options.source.scope === 'attempt') {
      this.acquiring?.controller.abort();
      this.acquiring = undefined;
    }
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) await withinCleanupBudget(handle.close(), context);
  }

  /** Ends the attempt, cancels a browser still opening, closes the browser, and releases what the source holds, each attempted whatever the others did. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    this.disposal.abort();
    const results = await Promise.allSettled([this.endAttempt(context)]);
    const acquiring = this.acquiring;
    this.acquiring = undefined;
    if (acquiring !== undefined) {
      acquiring.controller.abort();
      await withinCleanupBudget(acquiring.handle, context);
    }
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) results.push(...(await Promise.allSettled([boundedCleanup(handle.close(), context, 'browser close')])));
    results.push(...(await Promise.allSettled([this.options.source.dispose(context)])));
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
    kind: { readonly input?: boolean; readonly sensitive?: string; readonly traced?: boolean; readonly testCode?: boolean } = {},
  ): Promise<T> {
    this.session?.latch.throwPending();
    const session = this.session;
    const dispatches = new DispatchScope();
    let result: T;
    try {
      result = await withDeadline(operation, label, (budget) => dispatches.run(() => work(this.requireSession(), budget)));
    } catch (cause) {
      // A handler error latched while the operation ran is its cause: a route that refused its own arguments aborts the request the step waited on.
      session?.latch.throwPending();
      const dispatched = kind.input === true && dispatches.dispatched;
      throw afterDispatch(classify(cause, label, kind.testCode), label, dispatched, kind.sensitive);
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

  /** Replaces the tab with a blank one, keeping the attempt's storage. */
  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'restart', (session, budget) => restart(session, budget.signal));
  }

  /** Starts the attempt over in a clean user context. */
  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', (session, budget) => reset(session, budget.signal));
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
    return this.guard(operation, 'keyboard.press', (session, budget) => session.input.press(key, budget.signal), { input: true, traced: true });
  }

  /** One `browser.keyboard` call (`fixtureKeyStroke`); a key it holds stays held until its `keyboard.up`. */
  keyboard(label: string, key: string, phase: KeyPhase, operation: OperationContext): Promise<void> {
    return this.guard(operation, label, (session, budget) => session.input.key(fixtureKeyStroke(key, phase), budget.signal), { input: true });
  }

  /** Runs raw input sources from the `browser` fixture; a key or button they press without releasing stays held. */
  input(label: string, actions: Input.SourceActions[], operation: OperationContext): Promise<void> {
    return this.guard(operation, label, (session, budget) => session.input.send(actions, budget.signal), { input: true });
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

  /** Calls a compiled page function (`compileEvaluation`) with `arg` and returns its whole result; the test's code may change the page, as input would. */
  evaluate(declaration: string, arg: PageArgument | undefined, operation: OperationContext): Promise<PageValue> {
    return this.guard(operation, 'evaluate', (session) => {
      session.mutated();
      return session.call(declaration, arg === undefined ? [] : [arg], { awaitPromise: true, maxObjectDepth: null });
    }, { testCode: true });
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
    const { source } = this.options;
    if (source.kind === 'lease' && session.attempt.remoteDownloads === undefined) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', `browser provider "${source.leases.name}" serves no downloads, so a file its remote browser saves cannot be read back`, { retryable: false });
    }
    const endsAt = Date.now() + timeoutMs;
    const finished = await session.downloads.collect(count, trigger, signal, timeoutMs, (context) => session.onPage(context));
    const reading = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, endsAt - Date.now()))]);
    const saved: { path: string; absolutePath: string; suggestedFilename: string }[] = [];
    for (const download of finished) {
      const { relative, absolute } = session.artifactPath('downloads', download.suggestedFilename, '');
      await session.downloads.save(download, absolute, reading);
      saved.push({ path: relative, absolutePath: absolute, suggestedFilename: download.suggestedFilename });
    }
    return saved;
  }

  /**
   * Changes the attempt's media features from the next paint on. A browser
   * that does not emulate reduced motion (Firefox overrides only
   * `prefers-color-scheme` over BiDi) refuses a reduced-motion change;
   * `web({ reducedMotion })` still applies at launch.
   */
  emulateMedia(media: WebMedia, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'emulateMedia', async (session) => {
      if (!session.browser.traits.emulatesReducedMotion && media.reducedMotion !== undefined) {
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
    return this.guard(operation, 'state restore', (session, budget) => restoreState(session, state, budget.signal));
  }

  /** A masked viewport screenshot, saved under the attempt directory. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', (session, budget) => screenshot(session, label, budget.signal));
  }

  /** Starts the attempt's video: the provider's recording when it records, else the driver's own. */
  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', (session, budget) => startVideo(session, this.options.source.recorder(session.attempt.attemptId), budget.signal));
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
