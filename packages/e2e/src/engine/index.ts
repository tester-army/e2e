/**
 * The engine contract: the typed, model-free body of one target.
 *
 * An engine never talks to a model. It declares capabilities - observation,
 * actions, location, state, artifacts, contributed fixtures - and the harness
 * grades what a target can do from what its engine declares: observation
 * unlocks the judgment tier and prompt snapshots, `perform` unlocks the
 * harness-routed node actions (the agent's grammar verbs and the `screen`
 * tier's actions alike), location unlocks `screen`/`expect`. Every piece of
 * model-facing vocabulary is an agent-side `defineTool`; a target with no
 * engine at all is valid and simply runs everything opaque.
 *
 * Core knows this contract and never an engine's internals. The one platform
 * noun here is `platform`, the label an engine declares it drives and its
 * target inherits; no member's shape depends on it. A document engine, a
 * simulator engine, and a desktop engine fill in the same members with
 * different bodies.
 *
 * `defineEngine` is the loud manifest: capability detection happens here,
 * synchronously, at config load - a malformed engine fails the run instead
 * of silently demoting itself to a lower tier.
 */

import { engineBrand } from '../internal/brands.ts';

// Semantics the spec requires every engine and contributed fixture to
// reproduce exactly, exported so an engine never carries its own copy: the
// runner error taxonomy, text-pattern matching,
// URL matching, assertion polling, and
// the JSON-value rules for data a fixture returns.
export { ConfigurationError, InfrastructureError, TestError } from '../internal/errors.ts';
export { validateJsonValue, type JsonValueRules } from '../internal/json-value.ts';
export { describePattern, matchesText, toTextPattern } from '../internal/text.ts';
export type { TextMatch } from '../types.ts';
export { raceAbort } from './timing.ts';
export { Deadline, pollCondition, withTimeout, withinCleanupBudget, type PollConditionOptions } from '../internal/time.ts';
export { sameSite, siteOf, urlMatches } from '../internal/urls.ts';
export { obj, type WithoutUndefined } from '../internal/objects.ts';
import type { CommandConfig, Expectable, Locator, Screen, ServiceConfig } from '../types.ts';
import type {
  EngineSpiVersion,
  LocatorAction,
  LocatorActionKind,
  LocatorExpression,
  NodeRef,
  ObservationPixels,
  OperationContext,
  PointerAction,
  PointerActionKind,
  SemanticNode,
  ViewportPoint,
  ViewportSize,
} from './contract.ts';

export type * from './contract.ts';
export {
  ENGINE_ERROR_CODES,
  ENGINE_SPI_VERSION,
  EngineError,
  KEY_MODIFIERS,
  KEY_NAMES,
  LOCATOR_ACTION_KINDS,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  POINTER_ACTION_KINDS,
  RETRYABLE_ENGINE_ERROR_CODES,
  parseKey,
} from './contract.ts';
export type { CommandConfig, ServiceConfig, Expectable, JsonValue, Locator, Screen } from '../types.ts';

/**
 * Capability names: the closed harness capabilities plus one name per
 * contributed fixture. `actions` is `perform`; `location` is `locate`; both
 * require observation, because their refs live in the observation's id space.
 * `pointer` is `performAt`, an action addressed by a viewport point rather
 * than a node, and requires observation because the point is read off its
 * pixels.
 */
export type EngineCapability =
  | 'observation'
  | 'actions'
  | 'location'
  | 'pointer'
  | 'keyboard'
  | 'state'
  | 'artifacts'
  | (string & {});

/**
 * capability: keyboard - requires observation. Input to whatever holds focus,
 * with no node behind it: the agent's `type` and `press` without a target, and
 * the fallback of its point-addressed `type_at` and `press_at` when the point
 * lands on nothing the tree lists (a field drawn on a canvas, an input a
 * platform flattens out of its accessibility tree). Focus is the app's: the
 * harness tapped first, or the model said the field already has it.
 */
export interface EngineKeyboard {
  /**
   * Types `text` into the focused field as a person typing would, through
   * the platform's keyboard path: a browser dispatches the key events of each
   * character, a device sends the text through its keyboard. Where the
   * platform has key events the app must receive them; setting the value
   * without keystrokes is not a compliant implementation, since
   * `locator.pressSequentially` and the agent's `type` rely on the app
   * reacting as it does to a user. With `replace`, clears the field first
   * (select-all and delete on a keyboard surface; the platform's clear on a
   * device). Throw `NOT_ACTIONABLE` when nothing that accepts text has focus,
   * so the keystrokes are never silently discarded into the document body.
   */
  type(text: string, options: { readonly replace: boolean }, context: OperationContext): Promise<void>;
  /**
   * Sends one key of the contract grammar (`Enter`, `Escape`, `Tab`,
   * `Shift+Tab`, a character) to whatever holds focus. The harness has
   * already validated the key's shape; refuse with `UNSUPPORTED_CAPABILITY`
   * a key the surface cannot deliver.
   */
  press(key: string, context: OperationContext): Promise<void>;
  /** Hides an on-screen keyboard. Platforms without one leave it undefined. */
  dismiss?(context: OperationContext): Promise<void>;
}

/**
 * What an engine declares about the app it drives. The app
 * under test is the engine's to describe: a browser engine names a URL, a
 * device engine a bundle id. The harness resolves the declaration once per
 * target and owns everything built on it - navigation and origin policy,
 * cache and session identity, the report's target record, and the app
 * process it starts before the run.
 */
export interface EngineAppDeclaration {
  /**
   * Base URL of an addressable app: `app.open()` opens it and relative
   * navigation resolves against it. WHATWG-normalized; no userinfo, query, or
   * fragment; a missing scheme becomes `https://`, or `http://` for a
   * loopback host. Plain HTTP is accepted for loopback hosts only. A URL on
   * `127.0.0.1` or `[::1]` with port 0 asks the run for a free port,
   * substituted wherever the declaration used it and handed to `command` and
   * `services` as `{port}`.
   */
  readonly url?: string;
  /**
   * Labels the target in the report and joins the cache and session identity
   * digest; never gates a run. Defaults to `test` for loopback, `.localhost`,
   * and `.test` hosts and for a surface without a URL, `production` otherwise.
   */
  readonly environment?: 'test' | 'staging' | 'production';
  /**
   * Stable logical identity of the app under test, keying trace cache and
   * session entries. Defaults to the URL's origin and base path, so an
   * ephemeral per-deploy origin (a PR preview) cold-starts every entry; an
   * explicit identity keys them by what the app *is* instead of where it is
   * served this run. A surface without a URL has no default: declare one
   * (a bundle id, say) or entries key on the target alone. Never share one
   * identity across genuinely different apps: recorded traces would replay
   * across them.
   */
  readonly identity?: string;
  /**
   * Process the runner starts before the first test and stops on every exit
   * path (a dev server). Structured, never shell-interpreted; the child
   * inherits only `PATH`, `HOME`, the temp-directory variables, and
   * `command.env`. Targets declaring the same command share one process,
   * probed at the first declaring target's `readyUrl`.
   */
  readonly command?: CommandConfig;
  /** URL polled until `command` is ready (a 200-499 status); defaults to `url`. */
  readonly readyUrl?: string;
  /**
   * Dependency processes the app needs before it can boot (a database
   * container, a migration step), started in declaration order before any
   * app command and torn down in reverse after it. Valid without `command`:
   * the app may already be running, or be one of the services itself.
   * Services declared identically by several targets start once; shared
   * services must be declared in one order, and an explicit `name` must mean
   * one process across the run.
   */
  readonly services?: readonly ServiceConfig[];
}

/**
 * The site policy the harness resolved from the engine's declaration, handed
 * back at init, for the decisions only a surface can make: which nested
 * documents enter an observation, which requests carry injected credentials.
 */
export interface EngineAppInfo {
  /**
   * The site of the app's `url`, its registrable domain as `siteOf` reads it:
   * where the app's secrets, headers, and basic-auth credentials may go, and
   * whose child frames an observation reads; `sameSite` applies it. Absent
   * for an app without a URL, which is no policy at all. The URL itself stays
   * with the harness: a surface never learns where the app is.
   */
  readonly site?: string;
}

/** Explicit recording policy for one async fixture method. Arguments enter reports only through label. */
export interface FixtureOperation<Args extends unknown[] = unknown[]> {
  readonly kind: 'resource' | 'assertion';
  readonly label?: (...args: Args) => string;
  /** Action timeout by default; false when the method owns its assertion/navigation deadline. */
  readonly timeout?: number | false | ((...args: Args) => number | undefined);
  /** Assertions verify by default; waits may opt in as well. */
  readonly verifies?: boolean;
}

/** Only declared async methods are recorded. Sync accessors pass through unchanged. */
export type FixtureOperations<T extends object> = {
  readonly [Key in keyof T]?: T[Key] extends (...args: infer Args) => Promise<unknown>
    ? FixtureOperation<Args>
    : T[Key] extends object ? FixtureOperations<T[Key]> : never;
};

/** Context handed to a contributed fixture factory, once per attempt. */
export interface EngineFixtureContext {
  /** The target the fixture serves. */
  readonly targetName: string;
  /** Records the declared operations before invoking them; undeclared accessors retain their identity. */
  fixture<T extends object>(name: string, surface: T, operations: FixtureOperations<T>): T;
  readonly app: EngineAppInfo & {
    /**
     * Resolves a navigation target against the base URL. Throws
     * `APP_URL_REQUIRED` when the engine declared no URL and `POLICY_DENIED`
     * for a `file:`, `data:`, or `javascript:` scheme, so a fixture never
     * re-implements the rule the harness owns.
     */
    resolveUrl(url: string): string;
  };
  /** Harness budgets, for fixtures that poll or navigate. */
  readonly timeouts: {
    readonly test: number;
    readonly action: number;
    readonly assertion: number;
  };
  /**
   * The running phase's signal: the attempt's through `beforeEach` and the
   * body, then a fresh one per `afterEach` hook, `cleanup` callback, and
   * fixture teardown so teardown can still drive the app after a body timeout. Read it per call; a fixture factory that
   * captures it once keeps a signal that is dead by teardown.
   */
  readonly signal: AbortSignal;
  /** Per-call operation budget: the action timeout (or an explicit one) plus the attempt signal. */
  operation(timeoutMs?: number): OperationContext;
  /** Registers a file the current step produced under the attempt artifact directory. */
  attachArtifact(
    kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log',
    relativePath: string,
  ): void;
  /** Records the viewport the current step established. */
  attachViewport(viewport: { width: number; height: number; scale: number }): void;
  /** Mints a public locator from a raw expression (a platform selector, say). */
  locator(expression: LocatorExpression): Locator;
  /** Mints a screen scope whose every query is wrapped by `scope` (a nested document, say). */
  screen(scope: (expression: LocatorExpression) => LocatorExpression): Screen;
  /**
   * Attaches an expectation surface to a fixture object so `expect(fixture)`
   * returns it. The harness records every matcher call as an assertion step
   * named `expect.<matcher>`; the factory only decides what the matchers mean.
   */
  expectable<T extends object, E extends object>(target: T, factory: () => E): T & Expectable<E>;
}

/**
 * A contributed fixture: any record of async methods, sync accessors, and
 * nested namespaces, declared through context.fixture so its metadata controls
 * labels, deadlines and verification. The factory must return the declared
 * surface; a plain one is rejected with INVALID_CONFIG.
 */
export type EngineFixtureFactory = (context: EngineFixtureContext) => object;

/**
 * An opaque, restorable snapshot of an engine's state. `data` is JSON the
 * harness never inspects - a document platform's storage state, a device's app state, a
 * desktop's window state all satisfy it identically. `format`/`version` let a
 * engine reject a snapshot it can no longer read.
 */
export interface EngineState {
  /** Engine-defined format name. */
  readonly format: string;
  /** Format version, for rejecting a snapshot the engine can no longer read. */
  readonly version: number;
  /** Opaque JSON the runner never inspects. */
  readonly data: unknown;
  /** Earliest moment the state is known to be invalid, if the engine knows one. */
  readonly expiresAt?: string;
}

/**
 * Platform-neutral state capture and restore. A setup test captures a
 * snapshot; an ordinary test restores it at launch.
 *
 * Snapshots are credentials: cookies, tokens, and storage that authenticate
 * the app under test. The duties split at the seam. The harness owns the
 * snapshot from the moment `capture` returns: it encrypts it at rest with a
 * per-run AES-256-GCM key that never touches disk, stores it under the run's
 * private session directory, binds it to the run, target, engine, and app
 * identity, and deletes it when the run ends; it never logs it, reports it,
 * digests it, or sends it to a model. An engine MUST NOT persist, cache, or
 * log a snapshot on its own, MUST NOT echo snapshot contents in an error
 * message, and MUST treat `restore` as a replacement of the surface's whole
 * persisted state, never a merge, so a restored session cannot leak into the
 * next attempt.
 */
export interface EngineStateCapability {
  /** Captures the surface's persisted state. */
  capture(context: OperationContext): Promise<EngineState>;
  /** Replaces the surface's persisted state with `state`. */
  restore(state: EngineState, context: OperationContext): Promise<void>;
}

/**
 * Evidence capture. Paths are relative to the attempt artifact directory the
 * engine received in `startAttempt`.
 */
export interface EngineArtifacts {
  /** Captures a redacted screenshot; secure fields are masked at the source. */
  screenshot(label: string | undefined, context: OperationContext): Promise<string>;
  /** Starts recording an execution trace for the attempt. */
  startTrace?(context: OperationContext): Promise<void>;
  /**
   * Stops the trace and returns its relative path, or every archive written,
   * in order, when the trace had to be cut: a trace bound to one context
   * closes as a segment when a restart or a state reset replaces the
   * context, and a new one records on from there. The harness registers and
   * redacts each returned archive.
   */
  stopTrace?(context: OperationContext): Promise<string | readonly string[]>;
  /**
   * Starts recording the surface for the attempt. Declared together with
   * `stopVideo`. A surface that has nothing to show yet (no page open) may
   * defer the actual capture to the moment it does; the segments returned by
   * `stopVideo` say when each one began.
   */
  startVideo?(context: OperationContext): Promise<void>;
  /**
   * Stops recording and returns every segment written, in order. One segment
   * is the common case; a surface whose recording is bound to a page returns
   * one per page the attempt showed (a restart or a state reset opens a new
   * one). An attempt that never showed anything returns none.
   */
  stopVideo?(context: OperationContext): Promise<readonly VideoSegment[]>;
}

/** One recorded video file of an attempt. */
export interface VideoSegment {
  /** Path relative to the attempt artifact directory. */
  readonly path: string;
  /** When the segment started recording, as an ISO timestamp; its first frame is at or just after it. */
  readonly startedAt: string;
}

/**
 * Steering hooks behind the universal `app` fixture and the agent's
 * `navigate` verb. The app itself is described in `Engine.app`, as data;
 * node actions never live here, they are `perform`.
 *
 * `restart` and `reset` open nothing on an addressable surface: they end at
 * a fresh surface with no location shown, and the harness reopens the app
 * through `open` when the target has an address. A surface therefore never
 * needs to know the app's URL, and an unreachable app after a restart is
 * reported the same way as on first open. A surface without `open` (a
 * device with a pinned app) relaunches the app inside `restart` and `reset`
 * itself, since nothing else will.
 */
export interface EngineSession {
  /**
   * Opens one URL the harness already resolved against the base URL and the
   * origin policy. Absent on a surface without addressable locations.
   */
  open?(url: string, context: OperationContext): Promise<void>;
  /** Navigates back once in the surface's history. */
  back?(context: OperationContext): Promise<void>;
  /** Recreates the execution context, keeping persisted state. */
  restart?(context: OperationContext): Promise<void>;
  /** Clears persisted client state and recreates the execution context. */
  reset?(context: OperationContext): Promise<void>;
}

/**
 * What `prepare` learned that the run must honour. `workers` replaces the
 * engine's declared cap for this target and run: the surfaces the engine
 * actually provisioned, `1` to `info.slots`. Declared `workers` stays the
 * static answer for engines that know it up front.
 */
export interface EnginePrepareResult {
  /** Lowers the target's worker cap for this run, `1` to `info.slots`. */
  readonly workers?: number;
  /**
   * Variables every worker of this target is spawned with, on top of the
   * run's environment: how a runner-side `prepare` hands what it provisioned
   * (a device pool it discovered) to each worker's `init`. The run's own
   * variables win on a clash.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Facts handed to `prepare`, once per run and target in the runner process,
 * before any worker exists.
 */
export interface EnginePrepareInfo {
  /** The run id. */
  readonly runId: string;
  /** The target being prepared. */
  readonly targetName: string;
  /** Directory relative paths in the config resolve against; see `EngineInitInfo.projectRoot`. */
  readonly projectRoot: string;
  /**
   * The worker slots the run will start for this target, `0` to `slots - 1`:
   * the run's worker cap, the engine's declared `workers`, and the work units
   * selected for the target, whichever is smallest; `0` when nothing runs on
   * it. Provision for exactly these slots (boot that many devices of a pool);
   * `init` then finds them ready.
   */
  readonly slots: number;
  /**
   * The run's environment: what every worker is started with. A host may hand
   * the run an environment other than the runner process's own, so anything
   * provisioned here that a worker later looks up by environment (a browser
   * cache location) must be resolved and spawned against this, not
   * `process.env`.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Aborts on interrupt only. Provisioning has no budget: a first-run
   * download is as long as the network makes it, and cutting it short would
   * fail every test behind it.
   */
  readonly signal: AbortSignal;
  /**
   * Reports one line of progress. The runner streams it as a `notice` run
   * event, so it reaches the reporter and every host sink instead of being
   * written to a worker's stderr underneath the live status block.
   */
  readonly log: (line: string) => void;
}

/** Handed to `finish`, once per run and target after the last worker is gone, with the cleanup budget of one hook. */
export interface EngineFinishInfo extends EngineCleanupContext {
  /** The run id. */
  readonly runId: string;
  /** The target being finished. */
  readonly targetName: string;
  /** The run's environment, the same `prepare` saw. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reports one line of progress, streamed as a `notice` run event like `prepare`'s. */
  readonly log: (line: string) => void;
}

/** Run identity and harness-resolved facts handed to `init`, once per worker before the first step. */
export interface EngineInitInfo {
  /** The run id. */
  readonly runId: string;
  /** The target this worker serves. */
  readonly targetName: string;
  /**
   * Directory relative paths in the config resolve against: the config file's
   * directory, or the run's `cwd` for a programmatic config. An engine option
   * naming a file (a build to install) resolves here, never against
   * `process.cwd()`, which an in-process run does not change.
   */
  readonly projectRoot: string;
  /** The site policy resolved from the engine's `app` declaration. */
  readonly app: EngineAppInfo;
  /**
   * This worker's environment: the run's, plus what this target's `prepare`
   * returned in its result's `env`. Read what `prepare` provisioned from
   * here, never from `process.env`: an in-process worker shares its process
   * with the runner and every other target.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether the run asked for a visible surface (`--headed`). */
  readonly headed: boolean;
  /**
   * This worker's 0-based slot among the target's workers: the lowest slot
   * free when the worker was spawned, so a replacement worker takes over the
   * slot of the one that exited. An engine with several devices hands each
   * slot its own; `config.workers` bounds the slots a target can reach.
   */
  readonly workerSlot: number;
  /** Aborts on interrupt and when init exceeds the launch timeout; init must stop promptly. */
  readonly signal: AbortSignal;
}

/**
 * Per-attempt isolation context. An engine that must give each test a fresh
 * surface (a fresh isolated context per test, a reset device) sets it up in
 * `startAttempt` and tears it down in `endAttempt`.
 */
export interface EngineAttemptContext {
  /** The attempt id. */
  readonly attemptId: string;
  /** Absolute directory every artifact of this attempt is written under. */
  readonly artifactsDir: string;
  /**
   * Aborts with the attempt, and the moment `startAttempt` fails or exceeds
   * the launch timeout: a hook still running then must stop, because the
   * harness ends the attempt's isolation right behind it and may retry.
   */
  readonly signal: AbortSignal;
}

/**
 * Budget of one cleanup hook (`endAttempt`, `dispose`). `signal` aborts when
 * the budget is exhausted, so a hook that cannot finish in time stops instead
 * of running on into the next attempt's setup.
 */
export interface EngineCleanupContext {
  /** Aborts when the cleanup budget is spent. */
  readonly signal: AbortSignal;
  /** Remaining cleanup budget when the call starts. */
  readonly timeoutMs: number;
}

export interface EngineObserveOptions {
  /** Requests masked viewport pixels for the same revision as the tree. */
  readonly pixels?: boolean;
  /** Allows independently masked pixels to replace a failed semantic capture. Never granted after a secret fill. */
  readonly pixelFallback?: boolean;
}

/**
 * One fresh semantic snapshot of the surface under test. The harness owns
 * everything downstream: revision minting, secret redaction, and the
 * observation byte budget apply to every engine equally.
 */
export interface EngineSnapshot {
  /**
   * Where the surface is, as an opaque address the platform understands: a
   * URL on a document platform, the foreground screen or activity on a
   * device, the front window on a desktop. The harness shows it to the model
   * and to the report, anchors trace replay on it, and applies the origin
   * policy to it only when it parses as a URL. Omit when the platform has no
   * notion of a current location.
   */
  readonly location?: string;
  /**
   * The observation tree under one root the engine minted. The root's id MUST
   * be stable for the surface across observations: `perform(root, swipe)` is
   * the viewport swipe, and the harness addresses it from an earlier
   * observation, possibly one taken before a `restart` or `reset`, so the
   * root swipe MUST NOT depend on a live handle from that observation. A
   * platform with several top-level elements (a device's windows) wraps them
   * in a root of its own.
   */
  readonly root: SemanticNode;
  /** The viewport `SemanticNode.rect` and `ViewportPoint` are measured in. */
  readonly viewport: ViewportSize;
  /**
   * True when `root` leaves out nodes that are on the surface: the engine
   * stopped reading at a node cap or a depth limit, or could not enter a
   * child document. The harness tells the model the listing is incomplete
   * and never calls such a screen unchanged. Omit or set false for a tree
   * read whole.
   */
  readonly truncated?: boolean;
  /**
   * Semantic capture timed out. Return only the stable root reference, with no other fields,
   * and fresh pixels whose masking was proven independently of the failed
   * capture. Requires `pixelFallback`; callers must use the pixels as evidence
   * and must not replay or record a trace from this observation.
   */
  readonly treeUnavailable?: true;
  /** Masked pixels, when requested and producible; omitted otherwise. */
  readonly pixels?: ObservationPixels;
  /** Regions masked in `pixels`; the harness checks it covers every secure node. */
  readonly maskedRegionCount?: number;
}

/** The body of one target: typed, model-free, capability-graded. */
export interface Engine {
  /** Engine name, for diagnostics. */
  readonly name: string;
  /**
   * Implementation version, recorded as provenance and part of the trace
   * cache identity: an engine that resolves nodes differently must not replay
   * another version's traces, so an unversioned engine is not accepted.
   */
  readonly version: string;
  /**
   * Contract version literal. Additive optional members never bump it;
   * changed required semantics do.
   */
  readonly spiVersion: EngineSpiVersion;
  /**
   * Platform label this engine drives (`web`, `ios`, `android`, or a label of
   * the engine's own). Tests filter on it through `platforms` and tool packs
   * are scoped by it; the harness attaches no meaning to any value. A target
   * inherits it; a target that names a platform of its own must agree with it.
   */
  readonly platform?: string;
  /**
   * The most workers this engine can serve at once for one target: one per
   * surface it drives concurrently (a device pool's size; 1 for a single
   * simulator). The scheduler never runs more workers for the target, whatever
   * `config.workers` allows, so a device target shares a run with browser
   * targets without being over-subscribed. Omit when there is no such bound.
   */
  readonly workers?: number;
  /** capability: observation. */
  observe?(context: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot>;
  /**
   * capability: actions - requires observation. Performs exactly one action
   * on a ref this engine minted, from the newest observation or from
   * `locate` (both live in one id space), with the platform's actionability
   * checks. The agent's grammar verbs (tap, type, press, select, scroll) and
   * the `screen` tier's actions both bottom out here, so a surface
   * implements each action once. A `swipe` on the observation root is the
   * viewport swipe.
   *
   * Error contract (load-bearing for trace replay): throw a retryable
   * `NODE_STALE`-coded error when a ref no longer binds, and an
   * `ACTION_MAY_HAVE_COMMITTED`-coded error when input may have reached the
   * app - the harness never blindly repeats an uncertain mutation.
   */
  perform?(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void>;
  /**
   * The action kinds `perform` honors, required with it. The harness offers
   * the agent and the `screen` tier exactly these: a kind left out is never
   * presented as a tool that can only decline, and `screen`/`Locator` methods
   * for it fail with `UNSUPPORTED_CAPABILITY` before reaching the engine.
   * `perform` still throws `UNSUPPORTED_CAPABILITY` for a declared kind one
   * particular node cannot take (a `check` on a toggle whose state is unknown).
   */
  readonly actions?: readonly LocatorActionKind[];
  /**
   * capability: location - requires observation. Deterministic locator
   * resolution for the `screen`/`expect` tier: resolve one expression to the
   * nodes it currently matches. The harness owns polling, strictness, and
   * staleness; an engine resolves once, immediately.
   */
  locate?(
    expression: LocatorExpression,
    context: OperationContext,
  ): Promise<readonly SemanticNode[]>;
  /**
   * capability: pointer - requires observation. Performs one pointer action
   * at a viewport point, in the CSS pixels of `SemanticNode.rect`, with no
   * node behind it: the agent's `tap_at` verb lands here when the point the
   * model named in a screenshot sits on nothing the tree lists (a shape on a
   * canvas, a pin on a map, a control in a system sheet), and so do a test's
   * `screen.tapAt`, `screen.swipe({ from, to })`, and `tap({ position })`.
   * Dispatch the pointer at the point as given; the harness has clamped an
   * agent's point to the viewport and validated a test's. Throw
   * `UNSUPPORTED_CAPABILITY` for a declared kind the surface cannot deliver
   * at this particular point.
   */
  performAt?(point: ViewportPoint, action: PointerAction, context: OperationContext): Promise<void>;
  /**
   * The pointer action kinds `performAt` honors, required with it. The
   * harness routes a point-addressed action to the engine only for a kind
   * listed here; an undeclared kind fails with `UNSUPPORTED_CAPABILITY`
   * before reaching the engine.
   */
  readonly pointerActions?: readonly PointerActionKind[];
  /** capability: keyboard - requires observation. Input to whatever holds focus; see `EngineKeyboard`. */
  readonly keyboard?: EngineKeyboard;
  /**
   * Named deterministic surfaces this engine contributes to TestFixtures
   * (a device fixture, a document fixture - anything). Keys become fixture and
   * capability names; `requires: ['<name>']` gates at selection.
   */
  readonly fixtures?: Readonly<Record<string, EngineFixtureFactory>>;
  /** capability: state - opaque snapshot capture/restore for session reuse. */
  readonly state?: EngineStateCapability;
  /** capability: artifacts - screenshots and traces under the attempt directory. */
  readonly artifacts?: EngineArtifacts;
  /** The app under test, as data: url, identity, environment, command, services. */
  readonly app?: EngineAppDeclaration;
  /** Steering hooks: open, back, restart, reset. */
  readonly session?: EngineSession;
  /**
   * Once per run and target, in the runner process, before any worker starts
   * and outside every launch budget. Provision what the engine needs on this
   * machine here (a first-run browser download, a toolchain fetch), so it
   * happens once instead of per worker and its progress reaches the reporter
   * through `info.log`. It runs after collection and before the run's clock
   * starts: `plan` is emitted, the report's `startedAt` taken, and the app
   * started only once every target is prepared, so a download is never part
   * of a run's duration. Failure is infrastructure and ends the run before
   * any test executes. The result may lower the target's worker cap for this
   * run, for an engine that only learns its capacity here (a device pool
   * discovered from the booted devices).
   */
  prepare?(info: EnginePrepareInfo): Promise<void | EnginePrepareResult>;
  /**
   * Once per run and target, in the runner process, after every worker of
   * the target has been disposed and on every exit path: a passing run, a
   * failure, an interrupt, or a `prepare` that threw part-way. Release what
   * `prepare` acquired for the run here (a leased cloud device, a remote
   * session billed by the minute); per-worker resources belong in
   * `dispose`. Runs only when `prepare` was called, within the cleanup
   * budget and never cancelled by an interrupt: an interrupted run is exactly
   * when a leased device must still be released. A failure is a
   * cleanup-phase run error, never a crash.
   */
  finish?(info: EngineFinishInfo): Promise<void>;
  /**
   * Once per worker, before the first step; boot devices here, not in a step
   * budget. The same handle can be booted again after `dispose`: a config-held
   * handle outlives an in-process worker, so init MUST work on a disposed
   * engine as it does on a fresh one.
   */
  init?(info: EngineInitInfo): Promise<void>;
  /** Before each attempt: set up per-test isolation. */
  startAttempt?(context: EngineAttemptContext): Promise<void>;
  /**
   * After each attempt, within the cleanup budget: tear that isolation down.
   * MUST be idempotent, and safe to call after a failed `startAttempt`.
   */
  endAttempt?(context: EngineCleanupContext): Promise<void>;
  /**
   * Worker shutdown, within the cleanup budget; failure is a run error. Runs
   * whether or not `init` ran, so it MUST tolerate a cold engine.
   */
  dispose?(context: EngineCleanupContext): Promise<void>;
}

/** A validated engine: branded, frozen, capabilities computed. */
export interface EngineHandle extends Engine {
  readonly [engineBrand]: true;
  readonly capabilities: ReadonlySet<EngineCapability>;
}

export { defineEngine, isEngineHandle } from './manifest.ts';
