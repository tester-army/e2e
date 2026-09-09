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
 * Core knows this contract and never an engine's internals: no platform noun
 * appears here. A document engine, a simulator engine, and a desktop engine
 * fill in the same members with different bodies.
 *
 * `defineEngine` is the loud manifest: capability detection happens here,
 * synchronously, at config load - a malformed engine fails the run instead
 * of silently demoting itself to a lower tier.
 */

import { engineBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';

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
export { urlMatches } from '../internal/urls.ts';
export { obj, type WithoutUndefined } from '../internal/objects.ts';
import type {
  CommandConfig,
  Expectable,
  Locator,
  Momentum,
  Platform,
  Screen,
  ScrollDirection,
  ServiceConfig,
} from '../types.ts';
import {
  ENGINE_SPI_VERSION,
  type EngineSpiVersion,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type SemanticNode,
} from './contract.ts';

export type * from './contract.ts';
export {
  ENGINE_ERROR_CODES,
  ENGINE_SPI_VERSION,
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  RETRYABLE_ENGINE_ERROR_CODES,
} from './contract.ts';
export type {
  CommandConfig,
  ServiceConfig,
  Expectable,
  JsonValue,
  Locator,
  Momentum,
  Platform,
  Screen,
  ScrollDirection,
  SelectOption,
} from '../types.ts';

/**
 * Capability names: the closed harness capabilities plus one name per
 * contributed fixture. `actions` is `perform`; `location` is `locate`. Both
 * require observation, because their refs live in the observation's id space.
 */
export type EngineCapability =
  | 'observation'
  | 'actions'
  | 'location'
  | 'state'
  | 'artifacts'
  | (string & {});

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
   * loopback host. Plain HTTP is accepted for loopback hosts only.
   */
  readonly url?: string;
  /**
   * Origins navigation and secret fills admit; each entry a serialized
   * origin. Defaults to the URL's origin, or to none without a URL.
   */
  readonly allowedOrigins?: readonly string[];
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

/** The app under test as the harness resolved the engine's declaration, handed back at init. */
export interface EngineAppInfo {
  /**
   * Normalized base URL; the target of `app.open()` with no path. Absent when
   * the engine declared no `url`: a surface that needs one then fails the
   * call that needs it, and never navigates to a placeholder.
   */
  readonly baseUrl?: string;
  /** Origins navigation and cookie policy admit. */
  readonly allowedOrigins: readonly string[];
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
  readonly targetName: string;
  /** Records the declared operations before invoking them; undeclared accessors retain their identity. */
  fixture<T extends object>(name: string, surface: T, operations: FixtureOperations<T>): T;
  readonly app: EngineAppInfo & {
    /**
     * Resolves a navigation target against the base URL and the origin
     * policy. Throws `APP_URL_REQUIRED` when the engine declared no URL and
     * `POLICY_DENIED` for a disallowed origin or scheme, so a fixture never
     * re-implements the policy the harness owns.
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
  readonly format: string;
  readonly version: number;
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
  capture(context: OperationContext): Promise<EngineState>;
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
  /** Stops the trace and returns its relative path. */
  stopTrace?(context: OperationContext): Promise<string>;
}

/**
 * The app under test: what the engine declares about it
 * (`EngineAppDeclaration`) and the app-level hooks behind the universal
 * `app` fixture and the agent's `navigate` verb. Node actions never live
 * here; they are `perform`.
 */
export interface EngineApp extends EngineAppDeclaration {
  /**
   * Opens one URL the harness already resolved against the base URL and the
   * origin policy. Absent on a surface without addressable locations.
   */
  navigate?(url: string, context: OperationContext): Promise<void>;
  /** Navigates back once in the surface's history. */
  back?(context: OperationContext): Promise<void>;
  /** Recreates the execution context, keeping persisted state, and relaunches. */
  restart?(context: OperationContext): Promise<void>;
  /** Clears persisted client state and relaunches. */
  clearState?(context: OperationContext): Promise<void>;
}

/**
 * Facts handed to `prepare`, once per run and target in the runner process,
 * before any worker exists.
 */
export interface EnginePrepareInfo {
  readonly runId: string;
  readonly targetName: string;
  /**
   * The run's environment: what every worker is started with. A host may hand
   * the run an environment other than the runner process's own, so anything
   * provisioned here that a worker later looks up by environment (a browser
   * cache location) must be resolved and spawned against this, not
   * `process.env`.
   */
  readonly env: NodeJS.ProcessEnv;
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

/** Run identity and harness-resolved facts handed to `init`, once per worker before the first step. */
export interface EngineInitInfo {
  readonly runId: string;
  readonly targetName: string;
  /**
   * Directory relative paths in the config resolve against: the config file's
   * directory, or the run's `cwd` for a programmatic config. An engine option
   * naming a file (a build to install) resolves here, never against
   * `process.cwd()`, which an in-process run does not change.
   */
  readonly projectRoot: string;
  readonly app: EngineAppInfo;
  /** Attribute the `testId` query resolves against. */
  readonly testIdAttribute: string;
  /** Whether the run asked for a visible surface (`--headed`). */
  readonly headed: boolean;
  /** Aborts on interrupt and when init exceeds the launch timeout; init must stop promptly. */
  readonly signal: AbortSignal;
}

/**
 * Per-attempt isolation context. An engine that must give each test a fresh
 * surface (a fresh isolated context per test, a reset device) sets it up in
 * `startAttempt` and tears it down in `endAttempt`.
 */
export interface EngineAttemptContext {
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
  readonly signal: AbortSignal;
  /** Remaining cleanup budget when the call starts. */
  readonly timeoutMs: number;
}

export interface EngineObserveOptions {
  /** Requests masked viewport pixels for the same revision as the tree. */
  readonly pixels?: boolean;
}

/**
 * One fresh semantic snapshot of the surface under test. The harness owns
 * everything downstream: revision minting, secret redaction, and the
 * observation byte budget apply to every engine equally.
 */
export interface EngineSnapshot {
  /** Location captured with this tree, when the engine can provide it. */
  readonly url?: string;
  readonly nodes: readonly SemanticNode[];
  readonly viewport?: { readonly width: number; readonly height: number; readonly scale: number };
  /** Masked pixels, when requested and producible; omitted otherwise. */
  readonly pixels?: ObservationPixels;
  /** Regions masked in `pixels`; the harness checks it covers every secure node. */
  readonly maskedRegionCount?: number;
}

/** The body of one target: typed, model-free, capability-graded. */
export interface Engine {
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
   * Platform this engine drives (`web`, `ios`, `android`, or a label of the
   * engine's own). A target inherits it; a target that names a platform of
   * its own must agree with it.
   */
  readonly platform?: Platform;
  /** capability: observation. */
  observe?(context: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot>;
  /**
   * capability: actions - requires observation. Performs exactly one action
   * on a ref this engine minted, from the newest observation or from
   * `locate` (both live in one id space), with the platform's actionability
   * checks. The agent's grammar verbs (tap, type, press, select, node scroll)
   * and the `screen` tier's actions both bottom out here, so a surface
   * implements each action once.
   *
   * Error contract (load-bearing for trace replay): throw a retryable
   * `NODE_STALE`-coded error when a ref no longer binds, and an
   * `ACTION_MAY_HAVE_COMMITTED`-coded error when input may have reached the
   * app - the harness never blindly repeats an uncertain mutation.
   */
  perform?(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void>;
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
   * Viewport-level swipe behind the agent's `scroll` verb, `screen.swipe`,
   * and `scrollUntilVisible`; requires observation.
   */
  swipe?(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    context: OperationContext,
  ): Promise<void>;
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
  /** The app under test: its declaration (url, identity, command...) and hooks (navigate, back, restart, clearState). */
  readonly app?: EngineApp;
  /**
   * Current top-level URL of the surface, when the platform has one. Enables
   * trace start anchors and the secret-fill origin check.
   */
  url?(context: OperationContext): Promise<string>;
  /**
   * Once per run and target, in the runner process, before any worker starts
   * and outside every launch budget. Provision what the engine needs on this
   * machine here (a first-run browser download, a toolchain fetch), so it
   * happens once instead of per worker and its progress reaches the reporter
   * through `info.log`. It runs after collection and before the run's clock
   * starts: `plan` is emitted, the report's `startedAt` taken, and the app
   * started only once every target is prepared, so a download is never part
   * of a run's duration. Failure is infrastructure and ends the run before
   * any test executes.
   */
  prepare?(info: EnginePrepareInfo): Promise<void>;
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

/** Every key an engine may declare; anything else is rejected at config load. */
const KNOWN_KEYS = [
  'name',
  'version',
  'spiVersion',
  'platform',
  'observe',
  'locate',
  'perform',
  'swipe',
  'fixtures',
  'state',
  'artifacts',
  'app',
  'url',
  'prepare',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
] as const satisfies readonly (keyof Engine)[];

/** Keys of the nested manifests, closed like the top level. */
const NESTED_KEYS = {
  state: ['capture', 'restore'],
  artifacts: ['screenshot', 'startTrace', 'stopTrace'],
  app: ['navigate', 'back', 'restart', 'clearState'],
} as const;

/**
 * Declarative members of the `app` manifest: facts about the app under test,
 * copied through as data. Their values are validated when the config resolves
 * the target, where an error can name it.
 */
const APP_DECLARATION_KEYS = [
  'url',
  'allowedOrigins',
  'environment',
  'identity',
  'command',
  'readyUrl',
  'services',
] as const satisfies readonly (keyof EngineAppDeclaration)[];
const FUNCTION_MEMBERS = [
  'observe',
  'locate',
  'perform',
  'swipe',
  'url',
  'prepare',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
] as const;

/** Universal fixture names a contribution may never shadow. */
const RESERVED_FIXTURES = new Set(['agent', 'app', 'screen', 'platform', 'session']);

const FIXTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

function invalid(name: string, detail: string): ConfigurationError {
  return new ConfigurationError('INVALID_CONFIG', `engine "${name}": ${detail}`);
}

/**
 * Validates one nested manifest (`state`, `artifacts`, `app`): a plain object
 * whose keys are closed and whose declared members are functions, except the
 * `app` declaration's data members, which are copied through. Returns a copy
 * with every function bound to the manifest, so class-based bodies work.
 */
function nestedManifest<K extends keyof typeof NESTED_KEYS>(
  name: string,
  key: K,
  value: unknown,
  required: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(name, `${key} must be an object`);
  }
  const hooks: readonly string[] = NESTED_KEYS[key];
  const data: readonly string[] = key === 'app' ? APP_DECLARATION_KEYS : [];
  const source = value as Record<string, unknown>;
  for (const member of Object.keys(source)) {
    if (!hooks.includes(member) && !data.includes(member)) {
      throw invalid(
        name,
        `${key} has unknown key "${member}"; expected one of ${[...data, ...hooks].join(', ')}`,
      );
    }
  }
  const bound: Record<string, unknown> = {};
  for (const member of data) {
    const fact = source[member];
    if (fact === undefined) continue;
    if (typeof fact === 'function') throw invalid(name, `${key}.${member} is a declaration, not a hook`);
    bound[member] = fact;
  }
  for (const member of hooks) {
    const fn = source[member];
    if (fn === undefined) {
      if (required.includes(member)) throw invalid(name, `${key}.${member} must be a function`);
      continue;
    }
    if (typeof fn !== 'function') throw invalid(name, `${key}.${member} must be a function`);
    bound[member] = fn.bind(source);
  }
  return bound;
}

/**
 * Validates an engine and computes its capability set. Runs synchronously at
 * config load and fails loud: a misspelled member or an undeclared dependency
 * is `INVALID_CONFIG`, never a silent demotion to a lower tier.
 *
 * The handle is assembled member by member from the known keys, reading
 * through the prototype chain and binding every function to the spec, so a
 * class instance (own state fields included) is as valid a body as a literal.
 */
export function defineEngine(spec: Engine): EngineHandle {
  if (typeof spec !== 'object' || spec === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'defineEngine requires an engine object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'engine.name must be a non-empty string');
  }
  const name = spec.name;
  if (typeof spec.version !== 'string' || spec.version.trim() === '') {
    throw invalid(name, 'version must be a non-empty string; it is provenance and keys the trace cache');
  }
  if (spec.spiVersion !== ENGINE_SPI_VERSION) {
    throw invalid(
      name,
      `declares spiVersion ${String(spec.spiVersion)}; this runner supports ${ENGINE_SPI_VERSION}`,
    );
  }
  if (spec.platform !== undefined && (typeof spec.platform !== 'string' || spec.platform.trim() === '')) {
    throw invalid(name, 'platform must be a non-empty string when declared');
  }
  // A literal's unknown key is a misspelling or a misplaced tool; a class
  // instance's own fields are its state, so only literals are checked.
  if (Object.getPrototypeOf(spec) === Object.prototype) {
    const known: readonly string[] = KNOWN_KEYS;
    for (const key of Object.keys(spec)) {
      if (!known.includes(key)) {
        throw invalid(name, `unknown key "${key}" - tools belong on the agent, not the engine`);
      }
    }
  }
  for (const member of FUNCTION_MEMBERS) {
    if (spec[member] !== undefined && typeof spec[member] !== 'function') {
      throw invalid(name, `${member} must be a function`);
    }
  }

  const capabilities = new Set<EngineCapability>();
  if (spec.observe !== undefined) capabilities.add('observation');
  if (spec.perform !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares perform without observe: action targets are observation refs');
    }
    capabilities.add('actions');
  }
  if (spec.locate !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares locate without observe: located nodes share the observation id space');
    }
    capabilities.add('location');
  }
  if (spec.swipe !== undefined && !capabilities.has('observation')) {
    throw invalid(name, 'declares swipe without observe');
  }

  const handle: Record<string, unknown> = {
    name,
    version: spec.version,
    spiVersion: spec.spiVersion,
    ...(spec.platform === undefined ? {} : { platform: spec.platform }),
  };
  for (const member of FUNCTION_MEMBERS) {
    const fn = spec[member];
    if (fn !== undefined) handle[member] = fn.bind(spec);
  }
  if (spec.fixtures !== undefined) {
    if (typeof spec.fixtures !== 'object' || spec.fixtures === null) {
      throw invalid(name, 'fixtures must be an object');
    }
    for (const [fixture, factory] of Object.entries(spec.fixtures)) {
      if (!FIXTURE_NAME_PATTERN.test(fixture)) {
        throw invalid(name, `fixture name "${fixture}" must be a lower-camel identifier`);
      }
      if (RESERVED_FIXTURES.has(fixture)) {
        throw invalid(name, `fixture name "${fixture}" shadows a universal fixture`);
      }
      if (typeof factory !== 'function') {
        throw invalid(name, `fixtures.${fixture} must be a factory function`);
      }
      capabilities.add(fixture);
    }
    // Bound like every other member, so a class-based engine keeps `this`
    // in its fixture factories too.
    handle['fixtures'] = Object.freeze(
      Object.fromEntries(
        Object.entries(spec.fixtures).map(([fixture, factory]) => [
          fixture,
          (factory as (...args: unknown[]) => unknown).bind(spec),
        ]),
      ),
    );
  }
  if (spec.state !== undefined) {
    handle['state'] = nestedManifest(name, 'state', spec.state, ['capture', 'restore']);
    capabilities.add('state');
  }
  if (spec.artifacts !== undefined) {
    const artifacts = nestedManifest(name, 'artifacts', spec.artifacts, ['screenshot']);
    if ((artifacts['startTrace'] === undefined) !== (artifacts['stopTrace'] === undefined)) {
      throw invalid(name, 'artifacts.startTrace and stopTrace must be declared together');
    }
    handle['artifacts'] = artifacts;
    capabilities.add('artifacts');
  }
  if (spec.app !== undefined) handle['app'] = nestedManifest(name, 'app', spec.app);

  // Assembled key by key above, so the record is an Engine by construction.
  return Object.freeze({
    ...handle,
    [engineBrand]: true as const,
    capabilities,
  }) as unknown as EngineHandle;
}

/** True for a defineEngine-branded handle, across realms. */
export function isEngineHandle(value: unknown): value is EngineHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[engineBrand] === true
  );
}
