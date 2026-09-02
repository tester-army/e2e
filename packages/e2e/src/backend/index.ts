/**
 * The backend contract (RFC0002): the typed, model-free body of one target.
 *
 * A backend never talks to a model. It declares capabilities — observation,
 * actions — and the harness grades what a target can do from what its backend
 * declares: observation unlocks the judgment tier and prompt snapshots,
 * actions unlock the harness-routed grammar verbs. Every piece of
 * model-facing vocabulary is an agent-side `defineTool`; a target with no
 * backend at all is valid and simply runs everything opaque.
 *
 * `defineBackend` is the loud manifest: capability detection happens here,
 * synchronously, at config load — a malformed backend fails the run instead
 * of silently demoting itself to a lower tier.
 */

import type { LocatorExpression, NodeRef, OperationContext, SemanticNode } from '../driver/index.ts';
import { backendBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ScrollDirection } from '../types.ts';

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
  | (string & {});

/** Context handed to a contributed fixture factory, once per attempt. */
export interface BackendFixtureContext {
  readonly targetName: string;
  /** Per-call operation budget: the action timeout plus the attempt signal. */
  operation(): OperationContext;
}

/**
 * A contributed fixture: any record of async methods. The harness owns how
 * every call runs — a recorded, timeout-bounded step named
 * `<fixture>.<method>` — and never learns what the methods mean.
 */
export type BackendFixtureFactory = (
  context: BackendFixtureContext,
) => Readonly<Record<string, (...args: never[]) => Promise<unknown>>>;

/**
 * An opaque, restorable snapshot of a backend's state. `data` is JSON the
 * harness never inspects — a browser's storage state, a device's app state, a
 * desktop's window state all satisfy it identically. `format`/`version` let a
 * backend reject a snapshot it can no longer read.
 */
export interface BackendState {
  readonly format: string;
  readonly version: number;
  readonly data: unknown;
}

/**
 * Platform-neutral state capture and restore. A setup test captures a
 * snapshot; an ordinary test restores it at launch. Nothing here is
 * web-shaped: a Limrun backend implements it exactly as a browser does.
 */
export interface BackendStateCapability {
  capture(context: OperationContext): Promise<BackendState>;
  restore(state: BackendState, context: OperationContext): Promise<void>;
}

/** Run identity handed to `init`, once per worker before the first step. */
export interface BackendInitInfo {
  readonly runId: string;
  readonly targetName: string;
  /** Aborts on interrupt; init must stop promptly. */
  readonly signal: AbortSignal;
}

/**
 * Per-attempt isolation context. A backend that must give each test a fresh
 * surface (a browser context per test, a reset device) sets it up in
 * `startAttempt` and tears it down in `endAttempt`. Carries the two
 * harness-owned data a backend cannot self-provide: the attempt's artifact
 * directory and whether the run is headed.
 */
export interface BackendAttemptContext {
  readonly attemptId: string;
  readonly artifactsDir: string;
  readonly headed: boolean;
  readonly signal: AbortSignal;
}

/**
 * One fresh semantic snapshot of the surface under test. The harness owns
 * everything downstream: revision minting, secret redaction, and the
 * observation byte budget apply to every backend equally.
 */
export interface BackendSnapshot {
  readonly nodes: readonly SemanticNode[];
  readonly viewport?: { readonly width: number; readonly height: number; readonly scale: number };
}

/**
 * The typed verb set. Targets are refs from the newest observation. Declare
 * the verbs the surface supports; an absent verb fails a step action with
 * `UNSUPPORTED_CAPABILITY` instead of letting a model flail against it.
 *
 * Error contract (load-bearing for trace replay): throw a retryable
 * `NODE_STALE`-coded error when a ref no longer binds, and an
 * `ACTION_MAY_HAVE_COMMITTED`-coded error when input may have reached the
 * app — the harness never blindly repeats an uncertain mutation.
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
}

/** The body of one target: typed, model-free, capability-graded. */
export interface Backend {
  readonly name: string;
  /**
   * Contract version literal. Additive optional members never bump it;
   * changed required semantics do.
   */
  readonly spiVersion: 1;
  /** capability: observation. */
  observe?(context: OperationContext): Promise<BackendSnapshot>;
  /** capability: actions — requires observation (targets are observation refs). */
  readonly actions?: BackendActions;
  /**
   * capability: location — requires observation. Deterministic locator
   * resolution for the `screen`/`expect` tier: resolve one expression to the
   * nodes it currently matches. The harness owns polling, strictness, and
   * staleness; a backend resolves once, immediately.
   */
  locate?(
    expression: LocatorExpression,
    context: OperationContext,
  ): Promise<readonly SemanticNode[]>;
  /**
   * Named deterministic surfaces this backend contributes to TestFixtures
   * (a device fixture, a desktop fixture — anything). Keys become fixture
   * and capability names; `requires: ['<name>']` gates at selection.
   */
  readonly fixtures?: Readonly<Record<string, BackendFixtureFactory>>;
  /** capability: state — opaque snapshot capture/restore for session reuse. */
  readonly state?: BackendStateCapability;
  /** Once per worker, before the first step; boot devices here, not in a step budget. */
  init?(info: BackendInitInfo): Promise<void>;
  /** Before each attempt: set up per-test isolation (a fresh browser context). */
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
  'spiVersion',
  'observe',
  'actions',
  'locate',
  'fixtures',
  'state',
  'init',
  'startAttempt',
  'endAttempt',
  'dispose',
]);

/** Universal fixture names a contribution may never shadow. */
const RESERVED_FIXTURES = new Set(['agent', 'app', 'screen', 'platform', 'web', 'session']);

const FIXTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

const ACTION_VERBS = new Set(['tap', 'type', 'press', 'select', 'scroll', 'navigate']);

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
  if (spec.spiVersion !== 1) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `backend "${spec.name}" declares spiVersion ${String(spec.spiVersion)}; this runner supports 1`,
    );
  }
  for (const key of Object.keys(spec)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `backend "${spec.name}" has unknown key "${key}" — tools belong on the agent, not the backend`,
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
  for (const hook of ['init', 'startAttempt', 'endAttempt', 'dispose'] as const) {
    if (spec[hook] !== undefined && typeof spec[hook] !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `backend "${spec.name}": ${hook} must be a function`);
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
        `backend "${name}": unknown action verb "${verb}" — the grammar is closed; anything else is an agent tool`,
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
