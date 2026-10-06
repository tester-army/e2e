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
// runner error taxonomy, text-pattern matching, locator resolution over a
// semantic tree, URL matching, assertion polling, option-bag validation, the
// JSON-value rules for data a fixture returns, and the unknown-key check
// config options get.
export { ConfigurationError, InfrastructureError, TestError } from '../internal/errors.ts';
export { rejectUnknownKeys, rejectUnknownOptions } from '../internal/options.ts';
export { validateJsonValue, type JsonValueRules } from '../internal/json-value.ts';
export { describePattern, matchesText, toTextPattern } from '../internal/text.ts';
export { resolveExpression, type ResolveExpressionOptions } from './resolve.ts';
export type { TextMatch } from '../types.ts';
export { raceAbort } from './timing.ts';
export { isProviderRecording, stopProviderRecording } from './recording.ts';
export type {
  ProviderRecordContext,
  ProviderRecording,
  ProviderRecordingResult,
  ProviderRecordingStopContext,
  ProviderRecordingTarget,
} from './recording.ts';
export { Deadline, pollCondition, withTimeout, withinCleanupBudget, type PollConditionOptions } from '../internal/time.ts';
export { sameSite, siteOf, urlMatches } from '../internal/urls.ts';
export { obj, type WithoutUndefined } from '../internal/objects.ts';
import type { AppPermissionState, Expectable, Locator, Screen, Secret } from '../types.ts';
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
export type { AppPermissionState, Expectable, JsonValue, Locator, Screen, Secret } from '../types.ts';
export { isSecret } from '../secrets.ts';

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

/** Handed to `Engine.validateApp` beside the declaration. */
export interface EngineAppCheckInfo {
  /** The target declaring the app, for the message of a refusal. */
  readonly targetName: string;
}

/**
 * The app the harness resolved from the target's declaration, handed to
 * `prepare` and `init`: the site policy for the decisions only a surface can
 * make (which nested documents enter an observation, which requests carry
 * injected credentials), and what a device launches. The URL itself stays
 * with the harness: a surface never learns where the app is, and opens what
 * `session.open` is given.
 */
export interface EngineAppInfo {
  /**
   * The site of the app's `url`, its registrable domain as `siteOf` reads it:
   * where the app's secrets, headers, and basic-auth credentials may go, and
   * whose child frames an observation reads; `sameSite` applies it. Absent
   * for an app without a URL, which is no policy at all.
   */
  readonly site?: string;
  /** The installed app to launch, as the target declared it. */
  readonly bundleId?: string;
  /** The build to install, as the target declared it; relative to `projectRoot`. */
  readonly appPath?: string;
  /** Arguments every fresh launch passes the app. */
  readonly launchArguments?: readonly string[];
  /** Permissions the app holds on every fresh launch, by name. */
  readonly permissions?: Readonly<Record<string, AppPermissionState>>;
}

/**
 * The app a target declares, as its engine reads it at config load: what it
 * is and where it is served. The app is the target's alone
 * (`targets: [{ engine, app }]`); an engine only drives it. The harness has
 * checked the shape of every field before `Engine.validateApp` sees it, so
 * an engine can require what its platform needs (a URL, a bundle id) and
 * refuse what it cannot drive, naming the target.
 */
export type EngineAppDeclaration = EngineAppInfo & {
  /** Base URL the target opens, as declared; see `TargetApp.url`. */
  readonly url?: string;
};

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
     * `APP_URL_REQUIRED` when the target declares no URL and `POLICY_DENIED`
     * for any scheme but `http:` and `https:` (`about:blank` aside), so a
     * fixture never re-implements the rule the harness owns.
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
   * body, then a fresh one per `afterEach` hook so teardown can still drive
   * the app after a body timeout. Read it per call; a fixture factory that
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

/**
 * One recorded video of an attempt: a file the engine wrote into the attempt
 * artifact directory, or a recording a hosted service keeps and links to.
 */
export type VideoSegment = VideoFile | VideoLink;

/** A video file in the attempt artifact directory. */
export interface VideoFile {
  /** Path relative to the attempt artifact directory. */
  readonly path: string;
  /** When the segment started recording, as an ISO timestamp; its first frame is at or just after it. */
  readonly startedAt: string;
}

/** A recording a hosted service keeps, by URL: the report links to it and the runner never downloads it. */
export interface VideoLink {
  /** `http(s)` URL of the recording. */
  readonly url: string;
  /** Media type of what the URL serves: `video/mp4`, or `text/html` for a player page. */
  readonly mediaType: string;
  /** When the recording started, as an ISO timestamp; its first frame is at or just after it. */
  readonly startedAt: string;
}

/**
 * Steering hooks behind the universal `app` fixture and the agent's
 * `navigate` verb. The app itself is the target's `app`, handed over as data;
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
  /** The app the target declares, as `init` receives it: what a device installs or warms up here. */
  readonly app: EngineAppInfo;
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
  /** Whether the run asked for a visible surface (`--headed`), as `EngineInitInfo` declares it. */
  readonly headed: boolean;
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
  /** The app the target declares: the site policy of its URL, and what a device launches. */
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
  /**
   * Reports one line of progress. The runner streams it as a `notice` run
   * event, prefixed with the target and worker slot, so it reaches the
   * reporter and every host sink instead of being written to a worker's
   * stderr underneath the live status block. This is where a fact that only
   * exists once the worker is up belongs: the URL a hosted browser or device
   * can be watched at, which simulator a slot got, a version it detected.
   * Meant for `init` itself; a line logged later is still delivered while
   * the worker lives and dropped once it has exited. The line is shown as is
   * in reporters and host sinks, so keep tokens and other secrets out of it
   * (a viewer URL without its credential).
   */
  readonly log: (line: string) => void;
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
   * The plaintext of a secret the engine declared in `secrets`, for an
   * option the engine hands the app itself (basic-auth credentials). A
   * provider runs again on every call. The value, and every value
   * `options.derived` computes from it, join the attempt's redaction before
   * this resolves, so reports, logs, and every observation redact them, and
   * the attempt's trace and text downloads are rewritten. The protection is
   * text only: unlike a fill, it withholds no screenshot or model pixels.
   * A secret the engine did not declare is `SECRET_UNAVAILABLE`.
   */
  readonly resolveSecret: (secret: Secret, options?: ResolveSecretOptions) => Promise<string>;
  /**
   * Aborts with the attempt, and the moment `startAttempt` fails or exceeds
   * the launch timeout: a hook still running then must stop, because the
   * harness ends the attempt's isolation right behind it and may retry.
   */
  readonly signal: AbortSignal;
}

/** How `EngineAttemptContext.resolveSecret` treats what the engine makes of the value. */
export interface ResolveSecretOptions {
  /**
   * The forms of the value the app sees instead of the value itself, for the
   * same redaction under the secret's name: the base64 `user:password` an
   * `Authorization: Basic` header carries, which a page echoing its request
   * headers would otherwise show.
   */
  readonly derived?: (plaintext: string) => readonly string[];
}

/**
 * Budget of one cleanup hook (`settleAttempt`, `endAttempt`, `dispose`). `signal` aborts when
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
   * Declares that semantic node ids are never rebound to another node during
   * an attempt. Omit this for an engine whose ids are capture-scoped; the
   * runner retains its descriptor-based recovery for those engines.
   */
  readonly nodeIdentity?: 'stable';
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
  /**
   * The `secrets.get()` handles the engine's options hold, such as a
   * basic-auth password. The config load checks each names a configured
   * secret (`INVALID_CONFIG` otherwise), and only these resolve through
   * `EngineAttemptContext.resolveSecret`. The handles carry names only, so
   * no value reaches the config digest.
   */
  readonly secrets?: readonly Secret[];
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
  /**
   * The surface honors `modifiers` on the `tap`, `doubleTap`, and
   * `secondaryTap` actions `perform` receives, holding each key for the
   * click. Without it the harness fails an action that carries modifiers
   * with `UNSUPPORTED_CAPABILITY` before it reaches the engine, so an engine
   * that predates the field never drops one silently.
   */
  readonly tapModifiers?: boolean;
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
  /**
   * Checks the app a target declares against what this engine can drive, at
   * config load, synchronously: throw `INVALID_CONFIG` naming
   * `info.targetName` for a field the platform needs and the target left out
   * (a URL, a bundle id) or one it cannot drive. The harness has already
   * checked every field's shape.
   */
  validateApp?(app: EngineAppDeclaration, info: EngineAppCheckInfo): void;
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
   * After the body has settled, and again after teardown, before the verdict,
   * within the cleanup budget: report a failure that landed on a path no step
   * awaited (a callback the surface ran for the test: a request interceptor,
   * a native dialog handler). Wait for one still running, then throw its
   * error; the attempt fails with it the way a step would, an error already
   * classified keeping its code. MUST report each failure once.
   */
  settleAttempt?(context: EngineCleanupContext): Promise<void>;
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
