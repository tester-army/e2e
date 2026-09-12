/** Agent, model, and resource-limit resolution. */

import type { LanguageModel } from 'ai';
import { isStepExecutor, type StepExecutor } from '../agent/executor.ts';
import { boundedInt, positiveInt } from './validate.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { didYouMean } from '../internal/suggest.ts';
import type {
  AgentConfig,
  E2EConfig,
  ModelInstance,
  ProviderOptions,
  VisionMode,
} from '../types.ts';

/** A live AI SDK language model, as accepted by `generateText`. */
export type SdkLanguageModel = Exclude<LanguageModel, string>;

/**
 * Resolved model identity: a caller-supplied AI SDK model instance
 * (`gateway('openai/gpt-5.6-luna')`, `openrouter(...)`, `openai(...)`, any
 * `LanguageModelV2+`) and the provider and id it reports. The instance owns
 * its own transport and credentials; the runner constructs no model of its
 * own and reads no model variable from the environment. Instances never cross
 * a process boundary: workers re-resolve the config module and construct
 * their own.
 */
export interface ResolvedModel {
  readonly provider: string;
  readonly id: string;
  readonly model: SdkLanguageModel;
}

/** A resolved model as reports and diagnostics name it: the instance's `provider/model-id`. */
export function modelLabel(model: ResolvedModel): string {
  return `${model.provider}/${model.id}`;
}

export interface ResolvedAgentConfig {
  /**
   * The step executor `agent.act()` dispatches to, configured as the `agent`
   * value itself (`agent: createAgent(...)` or any StepExecutor); undefined
   * selects the default AI SDK executor at fixture time. Like model
   * instances, an executor never crosses a process boundary: workers
   * re-resolve the config module.
   */
  readonly executor: StepExecutor | undefined;
  /** Undefined until a model is configured; acquiring `agent` then fails. */
  readonly model: ResolvedModel | undefined;
  /**
   * The judgment tier's model: `agent.judge` or `createAgent({ judge })` when
   * one is configured (both set must agree), else `model`. Undefined only
   * when no model is configured at all, so downstream code has one rule:
   * judgments call `judge`.
   */
  readonly judge: ResolvedModel | undefined;
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  /** Deadline of one judgment-tier call (`assert`, `waitFor`, `extract`), in milliseconds. */
  readonly timeout: number;
  readonly maxObservationBytes: number;
  readonly context: string | undefined;
  /** Default for the per-call `vision` option; a per-call value always wins. */
  readonly vision: VisionMode;
  /**
   * Provider options sent with every model call, judgments included. This is
   * how a reasoning model's effort is lowered project-wide; an executor that
   * carries its own options keeps them.
   */
  readonly providerOptions: ProviderOptions | undefined;
}

export interface ResolvedLimits {
  readonly maxAgentContextBytes: number;
  readonly maxLedgerBytes: number;
  readonly maxObservationBytes: number;
  readonly maxEventsPerStep: number;
  readonly maxModelTokensPerCall: number;
}

/** `ResolvedLimits` before the agent-owned observation budget is attached. */
export type ResolvedBaseLimits = Omit<ResolvedLimits, 'maxObservationBytes'>;

const AGENT_KEYS = new Set([
  'executor',
  'model',
  'judge',
  'maxSteps',
  'maxModelCalls',
  'timeout',
  'maxObservationBytes',
  'context',
  'vision',
  'providerOptions',
]);

/**
 * Default observation byte budget, shared with the report's pre-config fallback
 * limits. A quarter mebibyte of tree is already tens of thousands of tokens on
 * every act turn; the per-call token ceiling clamps a dense screen below it.
 */
export const DEFAULT_OBSERVATION_BYTES = 262_144;

/**
 * Default judgment budget: one observation and one or two model calls. The
 * agent's own knob, deliberately apart from `actionTimeout`, so a slow judge
 * never inflates the engine's per-operation budget.
 */
const DEFAULT_JUDGMENT_TIMEOUT_MS = 30_000;

/** Hard ceilings mirroring `schema/report-v1.schema.json` `limits`. */
const LIMIT_BOUNDS = {
  maxAgentContextBytes: [1_024, 65_536, 16_384],
  maxLedgerBytes: [1_024, 65_536, 8_192],
  maxEventsPerStep: [1, 10_000, 1_000],
  maxModelTokensPerCall: [1, 1_000_000, 64_000],
} as const satisfies Record<string, readonly [number, number, number]>;

type LimitKey = keyof typeof LIMIT_BOUNDS;

/**
 * Resolves `config.agent`. `limits` must be resolved first: the context budget
 * is a limits key, and the dependency runs in exactly one direction.
 */
export function resolveAgentConfig(
  value: E2EConfig['agents'] extends Readonly<Record<string, infer Entry>> | undefined ? Entry | undefined : never,
  env: NodeJS.ProcessEnv,
  ci: boolean,
  limits: ResolvedBaseLimits,
  /** The config path of this agent in diagnostics: `agents.default`, `agents.ux`. */
  label = 'agents.default',
): ResolvedAgentConfig {
  // Three accepted shapes: the agent itself, an options object, or
  // an options object carrying `executor` — a custom brain no longer forfeits
  // the model, budgets, or context.
  const bare = value !== undefined && isStepExecutor(value) ? value : undefined;
  const agent = bare === undefined ? (value as AgentConfig | undefined) : undefined;
  let executor = bare;
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${label} must be an options object or the agent itself: createAgent(...) or any { name, runStep(context) }`,
      );
    }
    for (const key of Object.keys(agent)) {
      if (!AGENT_KEYS.has(key)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown ${label} key "${key}"${didYouMean(key, [...AGENT_KEYS])}`,
        );
      }
    }
    if (agent.executor !== undefined) {
      if (!isStepExecutor(agent.executor)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `${label}.executor must be a StepExecutor: createAgent(...) or any { name, runStep(context) }`,
        );
      }
      executor = agent.executor;
    }
  }

  const maxSteps = boundedInt(agent?.maxSteps, `${label}.maxSteps`, 1, 100) ?? 25;
  const maxModelCalls = boundedInt(agent?.maxModelCalls, `${label}.maxModelCalls`, 1, 100) ?? 25;
  const timeout = positiveInt(agent?.timeout, `${label}.timeout`, 'milliseconds') ?? DEFAULT_JUDGMENT_TIMEOUT_MS;
  const maxObservationBytes =
    boundedInt(agent?.maxObservationBytes, `${label}.maxObservationBytes`, 1_024, 16_777_216) ??
    DEFAULT_OBSERVATION_BYTES;


  const context = resolveContext(agent?.context, limits.maxAgentContextBytes, label);
  const vision = agent?.vision ?? false;
  if (!isVisionMode(vision)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label}.vision must be true, false, or 'only'`,
    );
  }

  const model = resolveCanonicalModel(agent?.model, executor?.model, label, 'model');
  return {
    executor,
    model,
    judge: resolveCanonicalModel(agent?.judge, executor?.judge, label, 'judge') ?? model,
    maxSteps,
    maxModelCalls,
    timeout,
    maxObservationBytes,
    context,
    vision,
    providerOptions: resolveProviderOptions(agent?.providerOptions, label),
  };
}

/**
 * Validates `agent.providerOptions`: a record of provider names to option
 * records, the shape the AI SDK reads. Option values are the provider's own
 * business and pass through untouched.
 */
function resolveProviderOptions(value: unknown, label: string): ProviderOptions | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label}.providerOptions must be an object keyed by provider name`,
    );
  }
  for (const [provider, options] of Object.entries(value)) {
    if (!isPlainObject(options)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${label}.providerOptions.${provider} must be an object of provider options`,
      );
    }
  }
  return value as ProviderOptions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves the `limits` block. The observation budget is attached by the caller. */
export function resolveLimits(raw: E2EConfig): ResolvedBaseLimits {
  const limits = raw.limits;
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      throw new ConfigurationError('INVALID_CONFIG', 'limits must be an object');
    }
    for (const key of Object.keys(limits)) {
      if (!(key in LIMIT_BOUNDS)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown limits key "${key}"${didYouMean(key, Object.keys(LIMIT_BOUNDS))}`,
        );
      }
    }
  }

  const resolved: Record<string, number> = {};
  for (const key of Object.keys(LIMIT_BOUNDS) as LimitKey[]) {
    const [min, max, fallback] = LIMIT_BOUNDS[key];
    resolved[key] = boundedInt(limits?.[key], `limits.${key}`, min, max) ?? fallback;
  }

  return resolved as unknown as ResolvedBaseLimits;
}

/** True for the closed `vision` value set, wherever it is supplied. */
export function isVisionMode(value: unknown): value is VisionMode {
  return typeof value === 'boolean' || value === 'only';
}

/**
 * Narrows a structurally verified model instance to the SDK model type. The
 * one place this cast lives; everything downstream takes the checked type.
 */
export function asSdkLanguageModel(instance: ModelInstance): SdkLanguageModel {
  if (!isModelInstance(instance)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'value is not an AI SDK language model instance',
    );
  }
  return instance as SdkLanguageModel;
}

/**
 * True when a config value is a live AI SDK language model instance. The check
 * is structural, exactly like the AI SDK's own model handling, so instances
 * from any realm or provider package are accepted.
 */
export function isModelInstance(value: unknown): value is ModelInstance {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['specificationVersion'] === 'string' &&
    typeof candidate['provider'] === 'string' &&
    typeof candidate['modelId'] === 'string' &&
    typeof candidate['doGenerate'] === 'function'
  );
}

/**
 * One model per slot. The model the executor brought (`createAgent({ model })`
 * or `createAgent({ judge })`) is it; without one, the agent's own key. A
 * config key naming a different model than the executor's is rejected: two
 * configured models for one slot would split the run silently.
 */
function resolveCanonicalModel(
  configured: ModelInstance | undefined,
  executorModel: ModelInstance | undefined,
  label: string,
  slot: 'model' | 'judge',
): ResolvedModel | undefined {
  const key = `${label}.${slot}`;
  if (executorModel === undefined) return resolveModel(configured, key);
  const own = resolveModel(executorModel, key) as ResolvedModel;
  if (configured === undefined) return own;
  const explicit = resolveModel(configured, key) as ResolvedModel;
  if (explicit.provider !== own.provider || explicit.id !== own.id) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${key} (${modelLabel(explicit)}) and the executor's own ${slot} (${modelLabel(own)}) differ; configure the ${slot} in one place`,
    );
  }
  return own;
}

/**
 * Resolves the model slot; `label` names the key the author wrote, so every
 * diagnostic points at it. There is no implicit default model and
 * no environment fallback; an unconfigured model fails at its first model
 * call, so a custom-executor run needs none.
 */
export function resolveModel(model: ModelInstance | undefined, label: string): ResolvedModel | undefined {
  if (model === undefined) return undefined;
  if (typeof model === 'string') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an AI SDK model instance, not the string ${JSON.stringify(model)}: import a provider and construct the model, e.g. gateway(${JSON.stringify(model)}) from 'ai' or openrouter(${JSON.stringify(model)}) from '@openrouter/ai-sdk-provider'`,
    );
  }
  if (!isModelInstance(model)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an AI SDK model instance, e.g. gateway('openai/gpt-5.6-luna') from 'ai'`,
    );
  }
  return {
    provider: model.provider,
    id: model.modelId,
    // Structurally verified above; the AI SDK duck-types models the same way.
    model: model as SdkLanguageModel,
  };
}

function resolveContext(context: string | undefined, maxBytes: number, label: string): string | undefined {
  if (context === undefined) return undefined;
  if (typeof context !== 'string') {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.context must be a string`);
  }
  const bytes = new TextEncoder().encode(context).byteLength;
  if (bytes > maxBytes) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label}.context is ${bytes} bytes; the resolved maximum is ${maxBytes}`,
    );
  }
  return context;
}
