/**
 * The Playwright surface: one browser per worker, one browser context per
 * attempt, and the page every engine member delegates to. This is the closure
 * state behind `web()`; the engine hooks in `engine.ts` and the `web`
 * fixture in `web.ts` are thin delegates onto it. Action dispatch lives in
 * `actions.ts` and tree capture in `observation.ts`. `AttemptSession` owns
 * the attempt's live binding, recovery, references, and recordings.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, ElementHandle, FrameLocator, Page, Route } from 'playwright';
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
  type EnginePrepareResult,
  type EngineFinishInfo,
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
import { matchesText } from 'e2e/engine';
import { classifyActionError, dispatchLocatorAction, dispatchPointerAction } from './actions.ts';
import { BrowserConnection, connectCdp, type BrowserName } from './browser-connection.ts';
import { AttemptSession, type StorageState } from './attempt-session.ts';
import type { CdpEndpointResolver } from './cdp-recovery.ts';
import { LeasedBrowsers, type BrowserProvider } from './provider.ts';
import { DialogRouter } from './dialogs.ts';
import { ensureBrowsersInstalled } from './install.ts';
import { applyPostSteps, frameSelectors, projectExpression } from './locators.ts';
import { ROOT_NODE_ID, toSemanticNode } from './observation.ts';
import { captureObservation } from './observation-capture.ts';
import { maskOptions, secureFieldMasks } from './observe.ts';
import { connectionAbort } from './operation-budget.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from './closed-shadow.ts';
import { readHandlesSemanticsFunction, readManySemanticsFunction, SECURE_FIELD_SELECTOR, type RawNodeData } from './read-node.ts';
import { httpCredentials, installSiteHeaders, lowercaseNames } from './protected-app.ts';
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
} from './support.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

const STATE_FORMAT = 'playwright-storage-state';

/** Default budget Playwright applies to context operations that carry no explicit timeout. */
const CONTEXT_DEFAULT_TIMEOUT_MS = 30_000;

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
 * `cdpEndpoint` at `init`, and again at an attempt start after a disconnect.
 * Supplying `reconnectEndpoint` opts into a persistent context instead.
 * CDP attach is chromium-only.
 */
export interface WebConnectOptions {
  /**
   * Resolves the CDP endpoint (a `ws://`/`wss://` or `http://` DevTools URL)
   * to attach to. Async because a hosted endpoint is not known at config load;
   * called once per worker in `init`, and again at the start of any attempt
   * that finds the session dropped, so a fresh per-run URL reconnects cleanly.
   * With `reconnectEndpoint`, init defers provisioning and every attempt
   * calls this resolver for a fresh, dedicated browser instead.
   * `signal` aborts when the init or attempt that needs the browser is
   * cancelled or exceeds its budget: a resolver that provisions a session
   * should stop and release it, since a browser that arrives late is detached.
   */
  readonly cdpEndpoint: (signal: AbortSignal) => string | Promise<string>;
  /**
   * Opts into a dedicated persistent remote context. `cdpEndpoint` provisions
   * a fresh browser at each attempt start; this resolver reconnects to that
   * same browser after a transport drop. Called once before the next
   * operation, within its budget. The original browser and page must survive.
   * Dispatched operations are never retried. The host owns browser cleanup.
   * Context replacement, headers, basicAuth, and userAgent are unavailable in this mode.
   */
  readonly reconnectEndpoint?: (signal: AbortSignal) => string | Promise<string>;
}

/** HTTP basic authentication the browser answers a `401` challenge with. */
export interface WebBasicAuth {
  /** The user name; `:` is not allowed in one (RFC 7617). */
  readonly username: string;
  readonly password: string;
}

/**
 * Options of the browser engine: the app it drives (`url`, `command`,
 * `services`, `environment`, `identity`, `readyUrl` - the
 * engine contract's app declaration) plus the browser itself.
 */
export interface WebOptions extends EngineAppDeclaration {
  /**
   * Browser to launch, `chromium` by default. A `BrowserProvider` leases
   * hosted browsers instead: one per worker slot at `prepare`, or one per
   * attempt, each attached to over CDP and released when its scope ends. A
   * provider implies chromium and excludes `connect`.
   */
  readonly browser?: BrowserName | BrowserProvider;
  /**
   * Initial viewport of every attempt's page; default 1280 by 720. `null`
   * emulates no size: the page fills the browser window, whatever size the
   * window has (a hosted browser's live view, a headed run), and
   * `web.setViewport` still fixes one for the rest of the attempt.
   */
  readonly viewport?: ViewportSize | null;
  /**
   * Attach to a remote browser over CDP instead of launching locally. Requires
   * the chromium browser (the default). Wired by a hosted-browser engine.
   */
  readonly connect?: WebConnectOptions;
  /**
   * HTTP headers added to every request the browser sends to an allowed
   * origin: a preview-protection bypass token, a tunnel's interstitial skip.
   * Requests to any other origin (a CDN, an analytics endpoint, an identity
   * provider) never carry them, so a header that is a secret stays with the
   * app it unlocks. Names are case-insensitive; a header the page already
   * sends under the same name is replaced. Applies to every path onto the
   * page, deterministic and agent-driven alike. Injecting headers routes
   * every request of the attempt, which turns the browser's HTTP cache off
   * and blocks service workers (a worker's requests bypass routing, so a
   * page it controlled would reach the gate bare), and a Playwright trace
   * records request headers.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * HTTP basic authentication for a staging app behind a browser challenge.
   * The browser answers a `401` with these credentials wherever one is
   * issued, as Playwright's own `httpCredentials` does. Applies to every path
   * onto the page.
   */
  readonly basicAuth?: WebBasicAuth;
  /**
   * The attribute that carries an element's test id: what the `testId` query
   * (`screen.getByTestId`) resolves and what `SemanticNode.testId` reports.
   * Defaults to `data-testid`.
   */
  readonly testIdAttribute?: string;
  /**
   * The `User-Agent` every attempt's context sends and `navigator.userAgent`
   * reports, as Playwright's own `userAgent` context option sets it: for an
   * app that switches into a test mode on a marker in the agent string.
   * Defaults to the browser's own. A `user-agent` entry in `headers` beside
   * it is `INVALID_CONFIG`, and so is a persistent context
   * (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`).
   */
  readonly userAgent?: string;
}

/** The test-id attribute when the options name none. */
const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

export class PlaywrightSurface {
  /**
   * Errors raised where nobody awaits them (dialog routing, route handlers)
   * wait here and fail the next step that enters the surface.
   */
  latch = new ErrorLatch();
  dialogs = new DialogRouter(this.latch);

  private readonly browserName: BrowserName;
  private readonly connection = new BrowserConnection();
  private readonly connect: WebConnectOptions | undefined;
  /** The provider's browsers, when `browser` names one; the runner and worker halves of the lease bookkeeping. */
  private readonly leases: LeasedBrowsers | undefined;
  private session: AttemptSession | undefined;
  private readonly usedContexts = new Set<string>();
  private readonly viewport: ViewportSize | null;
  /** Injected request headers, names lowercased so they replace the browser's own of the same name. */
  private readonly headers: Readonly<Record<string, string>> | undefined;
  private readonly basicAuth: WebBasicAuth | undefined;
  private readonly testIdAttribute: string;
  private readonly userAgent: string | undefined;
  private app: EngineAppInfo = {};
  private headed = false;
  private artifactsDir = '';
  private artifactCounter = 0;
  /**
   * Attempt-scoped network routes. Registered on the
   * context, not a page, so they cover every page the attempt opens - the
   * first navigation included - and re-applied to each context the attempt
   * replaces on `reset` or session restore.
   */
  private routes: StoredRoute[] = [];

  constructor(options: WebOptions) {
    this.browserName = typeof options.browser === 'string' ? options.browser : 'chromium';
    this.leases = typeof options.browser === 'object' && options.browser !== null ? new LeasedBrowsers(options.browser) : undefined;
    this.connect = options.connect;
    this.viewport = options.viewport === undefined ? DEFAULT_VIEWPORT : options.viewport;
    this.headers = options.headers === undefined ? undefined : lowercaseNames(options.headers);
    this.basicAuth = options.basicAuth;
    this.testIdAttribute = options.testIdAttribute ?? DEFAULT_TEST_ID_ATTRIBUTE;
    this.userAgent = options.userAgent;
  }

  // --- lifecycle ---

  /**
   * Installs the browser on first run, once per run before any worker, or
   * leases the run's browsers from a provider. A CDP attach uses the
   * remote's browser, so only a local launch needs the browser here. The
   * download narrates through `info.log` and is bounded by the run's
   * interrupt alone, never by a launch budget.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    if (this.leases !== undefined) return this.leases.prepare(info);
    if (this.connect !== undefined) return;
    await ensureBrowsersInstalled([this.browserName], { env: info.env, signal: info.signal, log: info.log });
  }

  /** Releases the browsers `prepare` leased; a local launch or a `connect` has nothing to release. */
  async finish(info: EngineFinishInfo): Promise<void> {
    await this.leases?.finish(info);
  }

  /** Provisions the shared browser once per worker: a local launch, or a CDP attach. */
  async init(info: EngineInitInfo): Promise<void> {
    this.app = info.app;
    this.headed = info.headed;
    this.leases?.init(info);
    // The browser was installed in `prepare`; a launch or attach is the one
    // boot step left that can outlive a launch budget, and it honours the
    // init signal.
    if (!this.persistent) await this.acquireBrowser(info.signal);
  }

  /** Whether attempts ride a persistent remote context, provisioned per attempt, instead of contexts on one shared browser. */
  private get persistent(): boolean {
    return this.connect?.reconnectEndpoint !== undefined || this.leases?.scope === 'attempt';
  }

  /**
   * Provisions the shared browser through the shared connection — a launch, or a CDP attach
   * via the connector — bounded by `signal`. Checked before the endpoint is
   * resolved: a cancelled caller must never provision a remote session it will
   * not use.
   */
  private async acquireBrowser(signal: AbortSignal): Promise<Browser> {
    const verb = this.connect === undefined && this.leases === undefined ? 'launch' : 'connect';
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
    const source = this.endpointSource();
    if (source === undefined) return undefined;
    return async () => {
      const endpoint = await source.resolve(signal);
      if (signal.aborted) throw cancelled('browser connect cancelled');
      if (typeof endpoint !== 'string' || endpoint.trim() === '') {
        throw new EngineError('ENGINE_FAILURE', `${source.name} resolved to an empty CDP endpoint`, {
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
   * Where the shared browser's CDP endpoint comes from: the `connect`
   * resolver, or the lease the worker holds from a provider; undefined for a
   * local launch.
   */
  private endpointSource(): { readonly name: string; readonly resolve: CdpEndpointResolver } | undefined {
    if (this.connect !== undefined) return { name: 'connect.cdpEndpoint', resolve: this.connect.cdpEndpoint };
    if (this.leases === undefined) return undefined;
    return { name: 'the browser provider', resolve: (signal) => this.leaseEndpoint(signal) };
  }

  /** The endpoint of the lease the worker holds; only reached with a provider. */
  private leaseEndpoint(signal: AbortSignal): Promise<string> {
    if (this.leases === undefined) throw invalidState('no browser provider is configured');
    return this.leases.endpoint(signal);
  }

  /**
   * The persistent remote context this attempt rides, when it does: the
   * `connect` resolvers, or a browser leased for this attempt alone, which
   * reconnects through the lease's own endpoint and is fresh by the
   * provider's contract, so no earlier attempt's context is checked against
   * it. Undefined for isolated contexts on the shared browser.
   */
  private async persistentBinding(
    context: EngineAttemptContext,
  ): Promise<{ provision: CdpEndpointResolver; reconnect: CdpEndpointResolver; usedContexts?: Set<string> } | undefined> {
    const { connect, usedContexts } = this;
    if (connect?.reconnectEndpoint !== undefined) {
      return { provision: connect.cdpEndpoint, reconnect: connect.reconnectEndpoint, usedContexts };
    }
    if (this.leases?.scope !== 'attempt') return undefined;
    const lease = await this.leases.startAttempt(context);
    return { provision: () => lease.cdpEndpoint, reconnect: () => lease.reconnectEndpoint ?? lease.cdpEndpoint };
  }

  /** Opens one attempt owner before setup starts, so cleanup can cancel pending attachment. */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running');
    const persistent = await this.persistentBinding(context);
    this.artifactsDir = context.artifactsDir;
    this.artifactCounter = 0;
    const routes: StoredRoute[] = [];
    this.latch = new ErrorLatch();
    const dialogs = new DialogRouter(this.latch);
    this.routes = routes;
    this.dialogs = dialogs;
    const credentials = httpCredentials(this.basicAuth);
    const session = new AttemptSession({
      artifactsDir: context.artifactsDir,
      viewport: this.viewport,
      acquire: (signal) => this.acquireBrowser(signal),
      contextOptions: {
        viewport: this.viewport,
        acceptDownloads: true,
        ...(credentials === undefined ? {} : { httpCredentials: credentials }),
        ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        ...(this.headers === undefined ? {} : { serviceWorkers: 'block' as const }),
      },
      configure: async (target) => {
        await target.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
        target.setDefaultTimeout(CONTEXT_DEFAULT_TIMEOUT_MS);
        target.on('dialog', (dialog) => { void dialogs.dispatch(dialog); });
        await installSiteHeaders(target, this.app.site, this.headers);
        for (const stored of routes) await target.route(stored.predicate, stored.handler);
      },
      ...(persistent === undefined ? {} : { persistent }),
    });
    this.session = session;
    await session.start(context.signal);
  }

  /**
   * Waits for a route or dialog handler still running, then rethrows the
   * error one of them latched after the last step, so it fails this attempt
   * instead of the next one's first operation. The latch itself is replaced
   * by `startAttempt`, after this ran.
   */
  settleAttempt(context: EngineCleanupContext): Promise<void> {
    return this.latch.settle(context);
  }

  /**
   * Retires the owner before awaiting cleanup; late work cannot reach the
   * next attempt. A browser leased for the attempt is released after its
   * connection closes, whether or not the close succeeded.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const session = this.session;
    this.session = undefined;
    try {
      if (session !== undefined) await session.close(context);
    } finally {
      await this.leases?.endAttempt(context);
    }
  }

  /**
   * Releases attempt resources, the worker's shared browser process, and a
   * lease the worker acquired for itself: three independent tasks, in that
   * order, every one attempted whatever the earlier ones did, and the first
   * failure reported once all ran. A billed browser outlives a failed trace
   * flush otherwise.
   */
  async dispose(context: EngineCleanupContext): Promise<void> {
    const tasks = [
      () => this.endAttempt(context),
      () => withinCleanupBudget(this.connection.dispose(), context),
      async () => this.leases?.dispose(context),
    ];
    let failure: { cause: unknown } | undefined;
    for (const task of tasks) {
      try {
        await task();
      } catch (cause) {
        failure ??= { cause };
      }
    }
    if (failure !== undefined) throw translatePwError(failure.cause, 'dispose');
  }

  /** Returns the active attempt, including its connection generation and references. */
  private requireSession(): AttemptSession {
    if (this.session === undefined) throw invalidState('no attempt is running');
    return this.session;
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
    const page = this.requireSession().current().page;
    if (page === null || page.isClosed()) throw invalidState('no app page is open; call app.open() or web.goto() first');
    return page;
  }

  requireContext(): BrowserContext {
    this.latch.throwPending();
    return this.requireSession().current().context;
  }

  /** Creates the active page through the attempt's sole binding owner. */
  ensurePage(): Promise<Page> {
    return this.requireSession().ensurePage();
  }

  /** Sizes the open page, or the one the next navigation opens, for the rest of the attempt. */
  setViewport(size: { readonly width: number; readonly height: number }): Promise<void> {
    return this.requireSession().setViewport(size);
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
    fn: (operation: OperationContext) => Promise<T>,
    translate: (cause: unknown, label: string) => Error = translatePwError,
  ): Promise<T> {
    this.latch.throwPending();
    try {
      return this.session === undefined
        ? await raceAbort(() => fn(operation), operation.signal, label)
        : await this.session.run(operation, label, fn);
    } catch (cause) {
      throw translate(cause, label);
    }
  }

  // --- steering: the session hooks ---

  /** Opens one URL the harness resolved; the attempt's page is created on first use. */
  open(url: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async (currentOperation) => {
      const page = await this.ensurePage();
      await page.goto(url, { waitUntil: 'load', timeout: currentOperation.timeoutMs });
    });
  }

  back(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'navigation', async (currentOperation) => {
      await this.requirePage().goBack({ waitUntil: 'load', timeout: currentOperation.timeoutMs });
    });
  }

  /** Restarts the document while retaining this attempt's context and storage. */
  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'restart', () => this.requireSession().restart());
  }

  /** Replaces the context with a clean one and opens its blank page. */
  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', async (currentOperation) => {
      const session = this.requireSession();
      await session.replace(undefined, currentOperation);
      await session.ensurePage();
    });
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
      async (currentOperation) => {
        const session = this.requireSession();
        const token = session.token();
        const refs = session.refs;
        const page = this.requirePage();
        await this.validateFrames(expression);
        const projected = projectExpression(page, expression, this.testIdAttribute);
        const { displayValue, name, steps } = projected;
        const readOptions = {
          testIdAttribute: this.testIdAttribute,
          secureFieldSelector: SECURE_FIELD_SELECTOR,
          mode: { kind: 'node' as const },
        };
        // A predicate-filtered match is one element among many candidates (every input with a
        // value, every control the label engine kept). Re-resolving it by position at action
        // time would act on a neighbor whenever the page inserted or removed an element in
        // between, so such matches are pinned to element handles: the handles are taken first
        // and the semantics are read from those very handles, so what was read and what is
        // acted on are one set of elements by construction.
        const handles =
          displayValue !== null || name !== null
            ? ((await projected.locator.elementHandles()) as ElementHandle<Element>[])
            : null;
        /** Disposes every handle this locate took, on the paths that hand none of them out. */
        const releaseHandles = (): void => {
          for (const handle of handles ?? []) void handle.dispose().catch(() => undefined);
        };
        const first = handles?.[0];
        const reads =
          handles === null
            ? await projected.locator.evaluateAll(readManySemanticsFunction, readOptions)
            : first === undefined
              ? []
              : await first.evaluate(readHandlesSemanticsFunction, { elements: handles, options: readOptions });
        // The page can replace a queried element before the read reaches it. Every element the
        // query returned is a match, except a display-value candidate, whose held value says
        // whether it was one. A match that left re-resolves the set, so a count or a single
        // match is never taken from what remains; a non-match that left drops out, so churn in
        // unrelated controls never holds up a query for a stable one.
        if (reads.some((read) => 'detached' in read && (displayValue === null || matchesText(read.value ?? '', displayValue)))) {
          releaseHandles();
          throw new EngineError('NODE_STALE', 'a match left the document while it was read', { retryable: true });
        }
        const candidates = reads.flatMap((raw, index) =>
          'detached' in raw || (projected.visible && raw.states.hidden) ? [] : [{ raw, index }],
        );
        // An exact label query matches any of the control's labels as the engine's reader names
        // them, so text a label marks aria-hidden (a required-field marker) never hides a field,
        // and an aria-label override or a second label does not either.
        const predicate =
          displayValue !== null
            ? (raw: RawNodeData) => matchesText(raw.value ?? '', displayValue)
            : name !== null
              ? (raw: RawNodeData) =>
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
        if (currentOperation.signal.aborted) {
          releaseHandles();
          throw cancelled('locate cancelled');
        }
        try { session.check(token); } catch (cause) {
          releaseHandles();
          throw cause;
        }
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
          const locator = reads.length === 1 ? projected.locator : projected.locator.nth(index);
          const id = refs.storeLocated(
            pinned === undefined ? { kind: 'locator', locator } : { kind: 'element', element: pinned },
          );
          return toSemanticNode({ id, revision: '' }, raw);
        });
      },
      staleOr,
    );
  }

  /**
   * One action on a located or observed node. A `swipe` on the observation
   * root is the viewport swipe: a wheel gesture sized by the viewport, with no
   * element resolved behind it, so it needs only the page. Every other action
   * on the root acts on the document element the root stands for.
   */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    return this.guard(
      operation,
      action.kind,
      (currentOperation) => {
        const page = this.requirePage();
        if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
          this.requireSession().requireObservation();
          return performViewportSwipe(page, action.direction, action.momentum ?? 'none');
        }
        return dispatchLocatorAction(this.requireSession().refs.lookup(ref), action, currentOperation.timeoutMs, (other) =>
          this.requireSession().refs.lookup(other),
        );
      },
      (cause) => classifyActionError(cause, action),
    );
  }

  /** One pointer action at a viewport point in CSS pixels, with nothing resolved behind it; see `dispatchPointerAction`. */
  performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    return this.guard(operation, `${action.kind} at point`, () => {
      this.requireSession().requireObservation();
      return dispatchPointerAction(this.requirePage(), point, action);
    });
  }

  /**
   * Types into whatever holds focus. Keystrokes into a document body are
   * accepted by the browser and lost, so the focused element is checked for
   * editability first and the call refuses rather than "typing" into nothing.
   * `replace` clears with select-all and delete: the only locator-free clear,
   * scoped by the browser to the whole editing host, so it is opt-in.
   */
  typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.type', async (currentOperation) => {
      const session = this.requireSession();
      session.requireObservation();
      const token = session.token();
      const page = this.requirePage();
      /** A delayed focus read or key must not continue input into a retired connection. */
      const checkpoint = (): void => {
        if (currentOperation.signal.aborted) throw connectionAbort(currentOperation.signal, 'keyboard.type');
        session.check(token);
      };
      await this.requireEditableFocus(page);
      checkpoint();
      if (options.replace) {
        await page.keyboard.press('ControlOrMeta+A');
        checkpoint();
        await page.keyboard.press('Delete');
        checkpoint();
      }
      await page.keyboard.type(text);
    });
  }

  /** Sends one key to whatever holds focus, in the contract's key grammar Playwright shares. */
  pressKey(key: string, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'keyboard.press', () => {
      this.requireSession().requireObservation();
      return this.requirePage().keyboard.press(key);
    });
  }

  /**
   * Refuses focused typing when nothing that takes keystrokes has focus, in
   * any frame of the page. Text fields and contenteditable hosts take them;
   * so does any other focusable element the app made focusable (a canvas, a
   * widget with a tabindex and its own key handling), because focusing it is
   * how the app opted into keys. Focus on the body, a button, a link, a
   * select, or a non-text input means the keystrokes would be discarded.
   */
  private async requireEditableFocus(page: Page): Promise<void> {
    const editable = await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate(() => {
            const active = document.activeElement;
            if (active === null || active === document.body || active === document.documentElement) return false;
            if (active instanceof HTMLInputElement) {
              return !active.disabled && !active.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(active.type);
            }
            if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
            if (active instanceof HTMLSelectElement || active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement) {
              return false;
            }
            return true;
          })
          .catch(() => false),
      ),
    );
    if (!editable.some(Boolean)) {
      throw new EngineError(
        'NOT_ACTIONABLE',
        'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
        { retryable: false },
      );
    }
  }

  /**
   * Checks that every frame selector along the expression matches exactly one
   * element, each counted inside the frame before it, the way `project` walks
   * the same chain; a frame-scoped `count` is 0 until that frame's document
   * has loaded, which is what makes `FRAME_NOT_FOUND` worth retrying.
   */
  private async validateFrames(expression: LocatorExpression): Promise<void> {
    let scope: Page | FrameLocator = this.requirePage();
    for (const selector of frameSelectors(expression)) {
      let count: number;
      try {
        count = await scope.locator(selector).count();
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
      scope = scope.frameLocator(selector);
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
    return this.guard(operation, 'screenshot', async (currentOperation) => {
      const page = this.requirePage();
      const { relative, absolute } = this.artifactPath('screenshots', label, '.png');
      await page.screenshot({
        path: absolute,
        timeout: currentOperation.timeoutMs,
        ...maskOptions(secureFieldMasks(page)),
      });
      return relative;
    });
  }

  /** Starts tracing the current attempt. */
  startTrace(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'trace', () => this.requireSession().startTrace());
  }

  /** Returns every trace segment finalized by the current attempt. */
  stopTrace(operation: OperationContext): Promise<string | readonly string[]> {
    return this.requireSession().collectTrace(operation);
  }

  /** Starts the attempt's video before a trace chooses its screencast dimensions. */
  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', () => this.requireSession().startVideo());
  }

  /** Finishes the attempt's recording and returns its finalized segments. */
  stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    return this.requireSession().collectVideo(operation);
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
    return this.guard(operation, 'state restore', async (currentOperation) => {
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
      await this.requireSession().replace(state.data, currentOperation);
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
      (currentOperation) => this.captureObservation(currentOperation, options),
      navigationStaleOr,
    );
  }

  /** Captures privately, then publishes only into the page and ref generation that requested it. */
  private async captureObservation(
    operation: OperationContext,
    options: EngineObserveOptions | undefined,
  ): Promise<EngineSnapshot> {
    const session = this.requireSession();
    const token = session.token();
    const refs = session.refs;
    const page = this.requirePage();
    const capture = refs.beginCapture();
    const captured = await captureObservation(page, refs, {
      testIdAttribute: this.testIdAttribute, site: this.app.site,
    }, operation, options);
    const { snapshot, generation } = captured;
    try {
      if (operation.signal.aborted) throw cancelled('observe cancelled');
      session.check(token);
      if (this.requirePage() !== page) {
        throw new EngineError('NODE_STALE', 'observation page was replaced', { retryable: true });
      }
      refs.publish(capture, captured);
      session.observedGeneration(token);
      return snapshot;
    } catch (cause) {
      RefRegistry.dispose(generation);
      throw cause;
    }
  }
}
