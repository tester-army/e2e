/**
 * Where the BiDi surface gets its browser: a local launch, the `connect`
 * endpoint, a browser provider's lease (one per worker or one per attempt),
 * or `attachBrowser`'s endpoint, whose open tab the attempt adopts. Each is
 * one `BrowserSource`, resolved once by `web()`; the surface asks it for a
 * browser and reads what it allows, never re-deriving the mode from options.
 */

import {
  EngineError,
  withTimeout,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EnginePrepareInfo,
  type EnginePrepareResult,
} from 'e2e/engine';
import { browserCheck, ensureBrowsersInstalled } from '../install/provision.ts';
import type { WebMedia } from '../media.ts';
import type { LeasedBrowsers, LeaseDownloads, LeaseRecording } from '../provider.ts';
import { cancelled } from '../support.ts';
import { ContextTree } from './context-tree.ts';
import { releaseQuietly } from '../errors.ts';
import { routeEvents, SESSION_EVENTS } from './events.ts';
import { connectBidiOverCdp, launchBidiBrowser, type BidiBrowser } from './launch.ts';
import type { BrowserName } from '../browsers.ts';
import type { BidiSession, UserContextMode } from './session.ts';

/** How long each stage of opening a browser (launch, attach, subscribe) may take. */
export const BROWSER_OPEN_TIMEOUT_MS = 60_000;

/** Resolves a CDP endpoint to attach to; `signal` aborts when the browser is no longer wanted. */
export type CdpEndpointResolver = (signal: AbortSignal) => string | Promise<string>;

/** What the surface asks a source for a browser with. */
interface BrowserRequestContext {
  /** Aborts when the browser is no longer wanted: the worker disposed, or the attempt it was for ended. */
  readonly signal: AbortSignal;
  /** The attempt the browser is for, in `attempt` scope. */
  readonly attempt?: EngineAttemptContext | undefined;
}

/** How a source provisions, opens, and gives back its browsers, beside what it allows. */
interface BrowserSourceStrategy {
  /** `worker`: one browser for the worker, opened at init and again once it drops. `attempt`: a fresh browser for every attempt. */
  readonly scope: 'worker' | 'attempt';
  /** The user context an attempt runs in. Only `fresh` lets an attempt replace it (`app.clearState()`, saved sessions). */
  readonly userContext: UserContextMode;
  /** Whether the browser's files are on this machine or on another one, which local paths do not reach. */
  readonly files: 'local' | 'remote';
  /** The `e2e doctor` checks of the browser. */
  doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]>;
  /** Provisions what the run's browsers need, once per run. */
  prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void>;
  /** Releases what `prepare` provisioned. */
  finish(info: EngineFinishInfo): Promise<void>;
  /** Records the worker's run, before any browser is opened. */
  init(info: EngineInitInfo): void;
  /** Opens one browser, failing `CANCELLED` once `request.signal` aborts at any stage. */
  open(request: BrowserRequestContext): Promise<BidiBrowser>;
  /** Gives back what `open` took for the attempt, in `attempt` scope; safe when it took nothing. */
  endAttempt(context: EngineCleanupContext): Promise<void>;
  /** Releases what the worker took for itself. */
  dispose(context: EngineCleanupContext): Promise<void>;
  /** How an attempt records the browser when its provider records it, in place of the screencast. */
  recorder(attemptId: string): ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined;
  /** How a download is read back off a browser on another machine, when its provider serves them. */
  downloads(): LeaseDownloads | undefined;
}

/** One of the ways the surface gets its browser. */
export type BrowserSource = BrowserSourceStrategy & (
  | { readonly kind: 'launch' }
  | { readonly kind: 'connect' }
  | { readonly kind: 'lease'; readonly leases: LeasedBrowsers }
  | { readonly kind: 'attach' }
);

/** The parts of a source that do nothing for it. */
const NOTHING = {
  finish: async (): Promise<void> => undefined,
  endAttempt: async (): Promise<void> => undefined,
  dispose: async (): Promise<void> => undefined,
  recorder: (): undefined => undefined,
  downloads: (): undefined => undefined,
};

/** A browser launched on this machine from the pinned build `prepare` installs into the run's browsers cache. */
export function launchSource(browser: BrowserName, media: WebMedia): BrowserSource {
  let run: { readonly headed: boolean; readonly env: Readonly<Record<string, string | undefined>> } | undefined;
  return {
    ...NOTHING,
    kind: 'launch',
    scope: 'worker',
    userContext: 'fresh',
    files: 'local',
    doctor: (info) => browserCheck(browser, info.env, info.headed),
    prepare: async (info) => {
      await ensureBrowsersInstalled([browser], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
    },
    init: (info) => {
      run = { headed: info.headed, env: info.env };
    },
    open: ({ signal }) => {
      if (run === undefined) throw new EngineError('ENGINE_FAILURE', 'the browser was asked for before init', { retryable: false });
      return launchBidiBrowser(browser, { headed: run.headed, env: run.env, timeoutMs: BROWSER_OPEN_TIMEOUT_MS, signal, firefoxPrefs: firefoxMediaPrefs(media) });
    },
  };
}

/**
 * A remote Chromium attached to over CDP at the endpoint `endpoint`
 * resolves: `web({ connect })`, whose attempts each get a fresh user
 * context, or `attachBrowser`, whose attempt adopts the tab open in the
 * browser's own one and leaves both as they are.
 */
export function cdpSource(kind: 'connect' | 'attach', endpoint: CdpEndpointResolver): BrowserSource {
  return {
    ...NOTHING,
    kind,
    scope: 'worker',
    userContext: kind === 'attach' ? 'adopt-tab' : 'fresh',
    files: 'local',
    doctor: async () => [{ id: 'browser', status: 'skip', message: 'the browser is attached over CDP' }],
    prepare: async () => undefined,
    init: () => undefined,
    open: async ({ signal }) => attach('connect.cdpEndpoint', await endpoint(signal), signal),
  };
}

/**
 * Browsers a provider leases: in `worker` scope one per worker slot, each
 * attempt in a fresh user context; in `attempt` scope a fresh browser per
 * attempt, run in that browser's own user context, which its `prepare` may
 * have signed in.
 */
export function leaseSource(leases: LeasedBrowsers): BrowserSource {
  return {
    kind: 'lease',
    leases,
    scope: leases.scope,
    userContext: leases.scope === 'attempt' ? 'default' : 'fresh',
    files: 'remote',
    doctor: async () => [{ id: 'browser', status: 'skip', message: `browsers come from the "${leases.name}" provider` }],
    prepare: (info) => leases.prepare(info),
    finish: (info) => leases.finish(info),
    init: (info) => leases.init(info),
    open: async ({ signal, attempt }) => {
      const endpoint = attempt === undefined ? await leases.endpoint(signal) : (await leases.startAttempt({ ...attempt, signal })).cdpEndpoint;
      return attach('the browser provider', endpoint, signal);
    },
    endAttempt: (context) => (leases.scope === 'attempt' ? leases.endAttempt(context) : Promise.resolve()),
    dispose: (context) => leases.dispose(context),
    recorder: (attemptId) => leases.recorder(attemptId),
    downloads: () => leases.downloads(),
  };
}

/**
 * Attaches over CDP to the endpoint `source` resolved, unless `signal`
 * aborted while it resolved; an empty endpoint is refused by the name of
 * its source.
 */
function attach(source: string, endpoint: unknown, signal: AbortSignal): Promise<BidiBrowser> {
  if (signal.aborted) throw cancelled('browser connect cancelled');
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new EngineError('ENGINE_FAILURE', `${source} resolved to an empty CDP endpoint`, { retryable: false });
  }
  return connectBidiOverCdp(endpoint, BROWSER_OPEN_TIMEOUT_MS, signal);
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

/**
 * One open browser as the surface holds it: the browser, its events routed
 * to the running attempt, and the tree of its browsing contexts, all ended
 * by one `close`.
 */
export class BrowserHandle {
  private constructor(
    readonly browser: BidiBrowser,
    readonly contexts: ContextTree,
    private readonly unroute: () => void,
  ) {}

  /**
   * Routes `browser`'s events to the attempt `current` returns, subscribes
   * to them, and adds the browsing contexts already open to the tree. A
   * browser that fails that, or whose `signal` aborted meanwhile, is closed.
   */
  static async open(browser: BidiBrowser, current: () => BidiSession | undefined, signal: AbortSignal): Promise<BrowserHandle> {
    const contexts = new ContextTree();
    // Routed before subscribing, so no context event is lost; the snapshot then adds the contexts already open.
    const unroute = routeEvents(browser.connection, contexts, current);
    try {
      await withTimeout(
        (async () => {
          await browser.connection.send('session.subscribe', { events: [...SESSION_EVENTS] });
          await contexts.sync(async () => (await browser.connection.send('browsingContext.getTree', {})).contexts);
        })(),
        BROWSER_OPEN_TIMEOUT_MS,
        () => new EngineError('OPERATION_TIMEOUT', `the browser did not take its event subscription and list its open contexts within ${BROWSER_OPEN_TIMEOUT_MS}ms`, { retryable: false }),
      );
      if (signal.aborted) throw cancelled('the browser was no longer wanted once it opened');
    } catch (cause) {
      unroute();
      await releaseQuietly(browser.close());
      throw cause;
    }
    return new BrowserHandle(browser, contexts, unroute);
  }

  /** Whether the browser is still connected. */
  get alive(): boolean {
    return !this.browser.connection.isClosed;
  }

  /** Stops routing its events and closes the browser: a launched one is killed, an attached one detached. */
  async close(): Promise<void> {
    this.unroute();
    await this.browser.close();
  }
}
