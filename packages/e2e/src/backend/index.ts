/**
 * The backend contract (RFC0002): the typed, model-free body of one target.
 *
 * A backend never talks to a model. It declares capabilities - observation,
 * actions, location, state, artifacts, contributed fixtures - and the harness
 * grades what a target can do from what its backend declares: observation
 * unlocks the judgment tier and prompt snapshots, actions unlock the
 * harness-routed grammar verbs, location unlocks `screen`/`expect`. Every
 * piece of model-facing vocabulary is an agent-side `defineTool`; a target
 * with no backend at all is valid and simply runs everything opaque.
 *
 * Core knows this contract and never a backend's internals: no platform noun
 * appears here. A document backend, a simulator backend, and a desktop backend
 * fill in the same members with different bodies.
 *
 * `defineBackend` is the loud manifest: capability detection happens here,
 * synchronously, at config load - a malformed backend fails the run instead
 * of silently demoting itself to a lower tier.
 */

import { backendBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { Expectable, Locator, Momentum, Screen, ScrollDirection } from '../types.ts';
import {
  BACKEND_SPI_VERSION,
  type BackendSpiVersion,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type SemanticNode,
} from './contract.ts';

export type * from './contract.ts';
export { BACKEND_SPI_VERSION, BackendError, OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT } from './contract.ts';
export type {
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
 * contributed fixture. Dependencies: actions and location require
 * observation (their refs live in the same semantic space).
 */
export type BackendCapability =
  | 'observation'
  | 'actions'
  | 'location'
  | 'state'
  | 'artifacts'
  | (string & {});

/** The app under test as the harness resolved it, shared with every backend. */
export interface BackendAppInfo {
  /**
   * Normalized base URL; the target of `app.open()` with no path. Absent when
   * the project configured no app URL: a surface that needs one then fails
   * the call that needs it, and never navigates to a placeholder.
   */
  readonly baseUrl?: string;
  /** Origins navigation and cookie policy admit. */
  readonly allowedOrigins: readonly string[];
}

/** Context handed to a contributed fixture factory, once per attempt. */
export interface BackendFixtureContext {
  readonly targetName: string;
  readonly app: BackendAppInfo & {
    /**
     * Resolves a navigation target against the base URL and the origin
     * policy. Throws `APP_URL_REQUIRED` when no app URL is configured and
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
  /** Aborts with the attempt. */
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
 * nested namespaces. The harness owns how every async method call runs - a
 * recorded, timeout-bounded step named `<fixture>.<method>` - and never
 * learns what the methods mean. A synchronous member is an accessor and is
 * returned as is.
 */
export type BackendFixtureFactory = (context: BackendFixtureContext) => object;

/**
 * An opaque, restorable snapshot of a backend's state. `data` is JSON the
 * harness never inspects - a document platform's storage state, a device's app state, a
 * desktop's window state all satisfy it identically. `format`/`version` let a
 * backend reject a snapshot it can no longer read.
 */
export interface BackendState {
  readonly format: string;
  readonly version: number;
  readonly data: unknown;
  /** Earliest moment the state is known to be invalid, if the backend knows one. */
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
 * private session directory, binds it to the run, target, backend, and app
 * identity, and deletes it when the run ends; it never logs it, reports it,
 * digests it, or sends it to a model. A backend MUST NOT persist, cache, or
 * log a snapshot on its own, MUST NOT echo snapshot contents in an error
 * message, and MUST treat `restore` as a replacement of the surface's whole
 * persisted state, never a merge, so a restored session cannot leak into the
 * next attempt.
 */
export interface BackendStateCapability {
  capture(context: OperationContext): Promise<BackendState>;
  restore(state: BackendState, context: OperationContext): Promise<void>;
}

/**
 * Evidence capture. Paths are relative to the attempt artifact directory the
 * backend received in `startAttempt`.
 */
export interface BackendArtifacts {
  /** Captures a redacted screenshot; secure fields are masked at the source. */
  screenshot(label: string | undefined, context: OperationContext): Promise<string>;
  /** Starts recording an execution trace for the attempt. */
  startTrace?(context: OperationContext): Promise<void>;
  /** Stops the trace and returns its relative path. */
  stopTrace?(context: OperationContext): Promise<string>;
}

/** App lifecycle hooks behind the universal `app` fixture. */
export interface BackendApp {
  /** Recreates the execution context, keeping persisted state, and relaunches. */
  restart?(context: OperationContext): Promise<void>;
  /** Clears persisted client state and relaunches. */
  clearState?(context: OperationContext): Promise<void>;
}

/** Run identity and harness-resolved facts handed to `init`, once per worker before the first step. */
export interface BackendInitInfo {
  readonly runId: string;
  readonly targetName: string;
  readonly app: BackendAppInfo;
  /** Attribute the `testId` query resolves against. */
  readonly testIdAttribute: string;
  /** Whether the run asked for a visible surface (`--headed`). */
  readonly headed: boolean;
  /** Aborts on interrupt; init must stop promptly. */
  readonly signal: AbortSignal;
}

/**
 * Per-attempt isolation context. A backend that must give each test a fresh
 * surface (a fresh isolated context per test, a reset device) sets it up in
 * `startAttempt` and tears it down in `endAttempt`.
 */
export interface BackendAttemptContext {
  readonly attemptId: string;
  /** Absolute directory every artifact of this attempt is written under. */
  readonly artifactsDir: string;
  readonly signal: AbortSignal;
}

export interface BackendObserveOptions {
  /** Requests masked viewport pixels for the same revision as the tree. */
  readonly pixels?: boolean;
}

/**
 * One fresh semantic snapshot of the surface under test. The harness owns
 * everything downstream: revision minting, secret redaction, and the
 * observation byte budget apply to every backend equally.
 */
export interface BackendSnapshot {
  readonly nodes: readonly SemanticNode[];
  readonly viewport?: { readonly width: number; readonly height: number; readonly scale: number };
  /** Masked pixels, when requested and producible; omitted otherwise. */
  readonly pixels?: ObservationPixels;
  /** Regions masked in `pixels`; the harness checks it covers every secure node. */
  readonly maskedRegionCount?: number;
}

/**
 * The typed verb set. Targets are refs the backend minted, from the newest
 * observation or from `locate`: both live in one id space, so a verb looks a
 * ref up the same way whichever tier minted it. Declare the verbs the surface
 * supports; an absent verb fails a step action with `UNSUPPORTED_CAPABILITY`
 * instead of letting a model flail against it.
 *
 * Error contract (load-bearing for trace replay): throw a retryable
 * `NODE_STALE`-coded error when a ref no longer binds, and an
 * `ACTION_MAY_HAVE_COMMITTED`-coded error when input may have reached the
 * app - the harness never blindly repeats an uncertain mutation.
 */
export interface BackendActions {
  tap?(target: { readonly ref: NodeRef }, context: OperationContext): Promise<void>;
  type?(
    target: { readonly ref: NodeRef },
    value: string,
    context: OperationContext,
  ): Promise<void>;
  press?(target: { readonly ref: NodeRef }, key: string, context: OperationContext): Promise<void>;
  select?(
    target: { readonly ref: NodeRef },
    value: string,
    context: OperationContext,
  ): Promise<void>;
  scroll?(
    direction: ScrollDirection,
    target: { readonly ref: NodeRef } | undefined,
    context: OperationContext,
  ): Promise<void>;
  navigate?(url: string, context: OperationContext): Promise<void>;
  /** Navigates back once in the surface's history. */
  back?(context: OperationContext): Promise<void>;
}

/** The body of one target: typed, model-free, capability-graded. */
export interface Backend {
  readonly name: string;
  /** Implementation version, recorded as provenance and in cache identity. */
  readonly version?: string;
  /**
   * Contract version literal. Additive optional members never bump it;
   * changed required semantics do.
   */
  readonly spiVersion: BackendSpiVersion;
  /** capability: observation. */
  observe?(context: OperationContext, options?: BackendObserveOptions): Promise<BackendSnapshot>;
  /** capability: actions - requires observation (targets are observation refs). */
  readonly actions?: BackendActions;
  /**
   * capability: location - requires observation. Deterministic locator
   * resolution for the `screen`/`expect` tier: resolve one expression to the
   * nodes it currently matches. The harness owns polling, strictness, and
   * staleness; a backend resolves once, immediately. Located ids share the
   * id space of observed ids, so `perform` and the grammar verbs accept either.
   */
  locate?(
    expression: LocatorExpression,
    context: OperationContext,
  ): Promise<readonly SemanticNode[]>;
  /**
   * Performs one deterministic action on a located node, with the platform's
   * actionability checks. Without it the location tier routes tap/fill/press/
   * select through the grammar verbs and reports every other action as
   * unsupported.
   */
  perform?(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void>;
  /** Viewport-level swipe behind `screen.swipe` and `scrollUntilVisible`. */
  swipe?(
    direction: ScrollDirection,
    momentum: Momentum | undefined,
    context: OperationContext,
  ): Promise<void>;
  /**
   * Named deterministic surfaces this backend contributes to TestFixtures
   * (a device fixture, a document fixture - anything). Keys become fixture and
   * capability names; `requires: ['<name>']` gates at selection.
   */
  readonly fixtures?: Readonly<Record<string, BackendFixtureFactory>>;
  /** capability: state - opaque snapshot capture/restore for session reuse. */
  readonly state?: BackendStateCapability;
  /** capability: artifacts - screenshots and traces under the attempt directory. */
  readonly artifacts?: BackendArtifacts;
  /** App lifecycle behind `app.restart()` and `app.clearState()`. */
  readonly app?: BackendApp;
  /**
   * Current top-level URL of the surface, when the platform has one. Enables
   * trace start anchors and the secret-fill origin check.
   */
  url?(context: OperationContext): Promise<string>;
  /** Once per worker, before the first step; boot devices here, not in a step budget. */
  init?(info: BackendInitInfo): Promise<void>;
  /** Before each attempt: set up per-test isolation. */
  startAttempt?(context: BackendAttemptContext): Promise<void>;
  /** After each attempt, bounded by the cleanup timeout: tear that isolation down. */
  endAttempt?(): Promise<void>;
  /** Worker shutdown, bounded by the cleanup timeout; failure is a run error. */
  dispose?(): Promise<void>;
}

/** A validated backend: branded, frozen, capabilities computed. */
export interface BackendHandle extends Backend {
  readonly [backendBrand]: true;
  readonly capabilities: ReadonlySet<BackendCapability>;
}

const KNOWN_KEYS = new Set([
  'name',
  'version',
  'spiVersion',
  'observe',
  'actions',
  'locate',
  'perform',
  'swipe',
  'fixtures',
  'state',
  'artifacts',
  'app',
  'url',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
]);

/** Universal fixture names a contribution may never shadow. */
const RESERVED_FIXTURES = new Set(['agent', 'app', 'screen', 'platform', 'session']);

const FIXTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

const ACTION_VERBS = new Set(['tap', 'type', 'press', 'select', 'scroll', 'navigate', 'back']);

const OPTIONAL_FUNCTION_MEMBERS = [
  'perform',
  'swipe',
  'url',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
] as const;

/**
 * Validates a backend and computes its capability set. Runs synchronously at
 * config load and fails loud: a misspelled member or an undeclared dependency
 * is `INVALID_CONFIG`, never a silent demotion to a lower tier.
 */
export function defineBackend(spec: Backend): BackendHandle {
  if (typeof spec !== 'object' || spec === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'defineBackend requires a backend object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'backend.name must be a non-empty string');
  }
  if (spec.version !== undefined && (typeof spec.version !== 'string' || spec.version === '')) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `backend "${spec.name}": version must be a non-empty string when present`,
    );
  }
  if (spec.spiVersion !== BACKEND_SPI_VERSION) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `backend "${spec.name}" declares spiVersion ${String(spec.spiVersion)}; this runner supports ${BACKEND_SPI_VERSION}`,
    );
  }
  for (const key of Object.keys(spec)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}" has unknown key "${key}" - tools belong on the agent, not the backend`,
      );
    }
  }
  const capabilities = new Set<BackendCapability>();
  if (spec.observe !== undefined) {
    if (typeof spec.observe !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `backend "${spec.name}": observe must be a function`);
    }
    capabilities.add('observation');
  }
  if (spec.actions !== undefined) {
    validateActions(spec.name, spec.actions);
    if (!capabilities.has('observation')) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}" declares actions without observe: action targets are observation refs`,
      );
    }
    capabilities.add('actions');
  }
  if (spec.locate !== undefined) {
    if (typeof spec.locate !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `backend "${spec.name}": locate must be a function`);
    }
    if (!capabilities.has('observation')) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}" declares locate without observe`,
      );
    }
    capabilities.add('location');
  }
  if ((spec.perform !== undefined || spec.swipe !== undefined) && spec.locate === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `backend "${spec.name}" declares perform/swipe without locate: they act on located nodes`,
    );
  }
  if (spec.fixtures !== undefined) {
    if (typeof spec.fixtures !== 'object' || spec.fixtures === null) {
      throw new ConfigurationError('INVALID_CONFIG', `backend "${spec.name}": fixtures must be an object`);
    }
    for (const [fixture, factory] of Object.entries(spec.fixtures)) {
      if (!FIXTURE_NAME_PATTERN.test(fixture)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `backend "${spec.name}": fixture name "${fixture}" must be a lower-camel identifier`,
        );
      }
      if (RESERVED_FIXTURES.has(fixture)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `backend "${spec.name}": fixture name "${fixture}" shadows a universal fixture`,
        );
      }
      if (typeof factory !== 'function') {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `backend "${spec.name}": fixtures.${fixture} must be a factory function`,
        );
      }
      capabilities.add(fixture);
    }
  }
  if (spec.state !== undefined) {
    if (
      typeof spec.state !== 'object' ||
      spec.state === null ||
      typeof spec.state.capture !== 'function' ||
      typeof spec.state.restore !== 'function'
    ) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}": state must be { capture, restore }`,
      );
    }
    capabilities.add('state');
  }
  if (spec.artifacts !== undefined) {
    if (
      typeof spec.artifacts !== 'object' ||
      spec.artifacts === null ||
      typeof spec.artifacts.screenshot !== 'function'
    ) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}": artifacts must declare a screenshot function`,
      );
    }
    if ((spec.artifacts.startTrace === undefined) !== (spec.artifacts.stopTrace === undefined)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}": artifacts.startTrace and stopTrace must be declared together`,
      );
    }
    capabilities.add('artifacts');
  }
  if (spec.app !== undefined) {
    if (typeof spec.app !== 'object' || spec.app === null) {
      throw new ConfigurationError('INVALID_CONFIG', `backend "${spec.name}": app must be an object`);
    }
    for (const hook of ['restart', 'clearState'] as const) {
      if (spec.app[hook] !== undefined && typeof spec.app[hook] !== 'function') {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `backend "${spec.name}": app.${hook} must be a function`,
        );
      }
    }
  }
  for (const member of OPTIONAL_FUNCTION_MEMBERS) {
    if (spec[member] !== undefined && typeof spec[member] !== 'function') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}": ${member} must be a function`,
      );
    }
  }
  return Object.freeze({
    ...spec,
    [backendBrand]: true as const,
    capabilities,
  });
}

function validateActions(name: string, actions: BackendActions): void {
  if (typeof actions !== 'object' || actions === null) {
    throw new ConfigurationError('INVALID_CONFIG', `backend "${name}": actions must be an object`);
  }
  let declared = 0;
  for (const [verb, handler] of Object.entries(actions)) {
    if (!ACTION_VERBS.has(verb)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${name}": unknown action verb "${verb}" - the grammar is closed; anything else is an agent tool`,
      );
    }
    if (handler === undefined) continue;
    if (typeof handler !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `backend "${name}": actions.${verb} must be a function`);
    }
    declared += 1;
  }
  if (declared === 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `backend "${name}" declares an actions object with no verbs; omit it instead`,
    );
  }
}

/** True for a defineBackend-branded handle, across realms. */
export function isBackendHandle(value: unknown): value is BackendHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[backendBrand] === true
  );
}
