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

import type { NodeRef, OperationContext, SemanticNode } from '../driver/index.ts';
import { backendBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { ScrollDirection } from '../types.ts';

/**
 * Capability names. Independent except for one edge: actions ⇒ observation.
 * A `location` capability (deterministic locators for `screen`/`expect`) is
 * designed in RFC0002 but not declared until the harness wires it.
 */
export type BackendCapability = 'observation' | 'actions';

/** Run identity handed to `init`, once per worker before the first step. */
export interface BackendInitInfo {
  readonly runId: string;
  readonly targetName: string;
  /** Aborts on interrupt; init must stop promptly. */
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
  /** Once per worker, before the first step; boot devices here, not in a step budget. */
  init?(info: BackendInitInfo): Promise<void>;
  /** Worker shutdown, bounded by the cleanup timeout; failure is a run error. */
  dispose?(): Promise<void>;
}

/** A validated backend: branded, frozen, capabilities computed. */
export interface BackendHandle extends Backend {
  readonly [backendBrand]: true;
  readonly capabilities: ReadonlySet<BackendCapability>;
}

const KNOWN_KEYS = new Set(['name', 'spiVersion', 'observe', 'actions', 'init', 'dispose']);

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
  for (const hook of ['init', 'dispose'] as const) {
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
