/**
 * The driver's surface: one browser per worker (or per attempt) and one
 * `BidiSession` per attempt, with the engine's lifecycle hooks and `guard`,
 * which bounds and classifies every operation. `engine.ts` binds each
 * contract hook to the driver module that implements it through `guard`;
 * the `browser` fixture calls the methods here, which keep it apart from
 * the session.
 */

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
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type OperationContext,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import type { DialogHandler } from './dialogs.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import { httpCredentials, lowercaseNames, siteHeadersFor } from '../protected-app.ts';
import type { WebBasicAuth, WebMedia, WebScreencastOptions } from '../options.ts';
import { typeInto } from './actions.ts';
import { DispatchScope } from './input.ts';
import { abortError, afterDispatch, cancelled, classify, type ErrorLatch, invalidState, releaseQuietly } from '../errors.ts';
import { BROWSER_OPEN_TIMEOUT_MS, BrowserHandle, type BrowserSource } from './browser-source.ts';
import { fixtureKeyStroke, type KeyPhase } from './keyboard.ts';
import type { NetworkRoute } from './network.ts';
import type { ObservedResponse } from './network-binding.ts';
import { traceScreen } from './observe.ts';
import { documentTitle } from '../in-page/page.ts';
import { BidiSession, type SessionSettings } from './session.ts';
import { goto, reload, traverse, type WaitUntil } from './steering.ts';
import type { PageArgument, PageValue } from './script.ts';

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
    const { source, headers, basicAuth: _basicAuth, ...configured } = this.options;
    const siteHeaders = headers === undefined ? undefined : lowercaseNames(headers);
    const site = info.app.site;
    this.settings = {
      ...configured,
      site,
      projectRoot: info.projectRoot,
      permissions: Object.keys(info.app.permissions ?? {}),
      remoteFiles: source.files === 'remote',
      userContext: source.userContext,
      env: info.env,
      holdRequests: siteHeaders !== undefined,
      siteHeaders: (url) => siteHeadersFor(url, site, siteHeaders),
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
  async guard<T>(
    operation: OperationContext,
    label: string,
    work: (session: BidiSession, budget: OperationBudget) => Promise<T>,
    kind: GuardKind = {},
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

  /** Goes back one history entry. */
  back(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => traverse(session, -1, budget.timeoutMs, budget.signal), { traced: true });
  }

  /** Goes forward one history entry. */
  forward(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => traverse(session, 1, budget.timeoutMs, budget.signal), { traced: true });
  }

  /** `browser.goto`: navigates and waits as `waitUntil` says. */
  goto(url: string, waitUntil: WaitUntil, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => goto(session, url, waitUntil, budget.signal), { traced: true });
  }

  /** Reloads the tab. */
  reload(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', (session, budget) => reload(session, budget.signal), { traced: true });
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

}

/** How `guard` treats an operation: whether it sends input, fills a sensitive value, shows the trace the screen it left, or runs the test's own code. */
export interface GuardKind {
  readonly input?: boolean;
  readonly sensitive?: string;
  readonly traced?: boolean;
  readonly testCode?: boolean;
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

/** What an operation may spend: its signal and the milliseconds left. */
export interface OperationBudget {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * How much sooner than an operation's deadline the driver's own timeout
 * fires: its error names what blocked an action, or that the input was
 * already dispatched, and this lead lets that answer arrive before the
 * deadline does. The deadline is for the calls the browser never answers: an
 * evaluate, which takes no timeout, and a point tap on a page whose renderer
 * is stuck in a script. A budget shorter than twice the lead splits in half.
 */
const DRIVER_TIMEOUT_LEAD_MS = 250;

/**
 * Bounds one operation by its budget: work still pending at the deadline is
 * aborted and abandoned as `OPERATION_TIMEOUT` instead of holding the test
 * until its own timeout. `work` gets a signal that aborts at the deadline or
 * on cancellation, and the time to pass the driver's own timeouts, which
 * fire `DRIVER_TIMEOUT_LEAD_MS` sooner.
 */
async function withDeadline<T>(operation: OperationBudget, label: string, work: (budget: OperationBudget) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([operation.signal, controller.signal]);
  const expire = (): void => controller.abort(new EngineError('OPERATION_TIMEOUT', `${label} timed out`, { retryable: false }));
  if (operation.timeoutMs <= 0) expire();
  const timer = setTimeout(expire, Math.max(0, operation.timeoutMs));
  try {
    if (signal.aborted) throw abortError(signal, label);
    const lead = Math.min(DRIVER_TIMEOUT_LEAD_MS, operation.timeoutMs / 2);
    return await raceAbort(() => work({ signal, timeoutMs: Math.ceil(operation.timeoutMs - lead) }), signal, label);
  } catch (cause) {
    if (signal.aborted) throw abortError(operation.signal.aborted ? operation.signal : signal, label);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
