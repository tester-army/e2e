/** Agent, model, and resource-limit resolution (spec 05-config.md, 14-security.md). */

import type { LanguageModel } from 'ai';
import { isStepExecutor, type StepExecutor } from '../agent/executor.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { isLoopbackHost } from '../internal/urls.ts';
import type { AgentConfig, E2EConfig, ModelConfig, ModelInstance, VisionMode } from '../types.ts';

/** Default environment variable holding the provider credential. */
const DEFAULT_API_KEY_ENV = 'E2E_MODEL_API_KEY';

/** Gateway-native credential variable, used when apiKeyEnv holds no value. */
export const GATEWAY_API_KEY_ENV = 'AI_GATEWAY_API_KEY';

/** A live AI SDK language model, as accepted by `generateText`. */
export type SdkLanguageModel = Exclude<LanguageModel, string>;

/**
 * Resolved model identity. Two shapes cover every provider:
 *
 * - `gateway`: a `provider/model-id` reference routed through the AI Gateway.
 *   The credential is resolved from the environment here so nothing downstream
 *   needs the process environment; it never enters digests, logs, or reports.
 * - `instance`: a caller-supplied AI SDK provider model (`openai('gpt-4o')`,
 *   `anthropic(...)`, any `LanguageModelV2+`). The instance owns its own
 *   transport and credentials. Instances never cross a process boundary:
 *   workers re-resolve the config module and construct their own.
 */
export type ResolvedModel =
  | {
      readonly kind: 'gateway';
      readonly provider: string;
      readonly id: string;
      /** Absolute endpoint override, or undefined for the gateway default. */
      readonly endpoint: string | undefined;
      readonly apiKeyEnv: string;
      /** Resolved credential; absence fails at the first model call, not here. */
      readonly apiKey: string | undefined;
    }
  | {
      readonly kind: 'instance';
      readonly provider: string;
      readonly id: string;
      readonly model: SdkLanguageModel;
    };

export interface ResolvedAgentConfig {
  /**
   * The step executor `agent.act()` dispatches to, configured as the `agent`
   * value itself (any StepExecutor); undefined
   * selects the default AI SDK executor at fixture time. Like model
   * instances, an executor never crosses a process boundary: workers
   * re-resolve the config module.
   */
  readonly executor: StepExecutor | undefined;
  /** Undefined until a model is configured; acquiring `agent` then fails. */
  readonly model: ResolvedModel | undefined;
  /**
   * Model used by calls with `vision`. Visual grounding is a much higher bar
   * than accepting an image, so the tier that needs it can be pinned
   * separately. Undefined falls back to `model`.
   */
  readonly visionModel: ResolvedModel | undefined;
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxObservationBytes: number;
  readonly context: string | undefined;
  /** Default for the per-call `vision` option; a per-call value always wins. */
  readonly vision: VisionMode;
  /**
   * Who judges `assert`/`waitFor`/`extract`: the single-call judgment tier on
   * `model` (default), or the configured executor through the socket.
   */
  readonly judgments: 'model' | 'executor';
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
  'visionModel',
  'maxSteps',
  'maxModelCalls',
  'maxObservationBytes',
  'context',
  'vision',
  'judgments',
]);

const MODEL_KEYS = new Set(['provider', 'id', 'endpoint', 'apiKeyEnv']);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Hard ceilings mirroring spec/schema/report-v1.schema.json `limits`. */
const LIMIT_BOUNDS = {
  maxAgentContextBytes: [1_024, 65_536, 16_384],
  maxLedgerBytes: [1_024, 65_536, 8_192],
  maxEventsPerStep: [1, 10_000, 1_000],
  maxModelTokensPerCall: [1, 1_000_000, 64_000],
} as const satisfies Record<string, readonly [number, number, number]>;

type LimitKey = keyof typeof LIMIT_BOUNDS;

/**
 * Resolves `config.agent` plus model environment fallbacks. `limits` must be
 * resolved first: the context budget is a limits key, and the dependency runs
 * in exactly one direction.
 */
export function resolveAgentConfig(
  raw: E2EConfig,
  env: NodeJS.ProcessEnv,
  ci: boolean,
  limits: ResolvedBaseLimits,
): ResolvedAgentConfig {
  const value = raw.agent;
  // Three accepted shapes (RFC0002): the agent itself, an options object, or
  // an options object carrying `executor` — a custom brain no longer forfeits
  // the model, budgets, or context.
  const bare = value !== undefined && isStepExecutor(value) ? value : undefined;
  const agent = bare === undefined ? (value as AgentConfig | undefined) : undefined;
  let executor = bare;
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'agent must be an options object or the agent itself: any { name, runStep(context) }',
      );
    }
    for (const key of Object.keys(agent)) {
      if (!AGENT_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown agent config key "${key}"`);
      }
    }
    if (agent.executor !== undefined) {
      if (!isStepExecutor(agent.executor)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          'agent.executor must be a StepExecutor: any { name, runStep(context) }',
        );
      }
      executor = agent.executor;
    }
  }

  const maxSteps = boundedInt(agent?.maxSteps, 'agent.maxSteps', 1, 100) ?? 25;
  const maxModelCalls = boundedInt(agent?.maxModelCalls, 'agent.maxModelCalls', 1, 100) ?? 25;
  const maxObservationBytes =
    boundedInt(agent?.maxObservationBytes, 'agent.maxObservationBytes', 1_024, 16_777_216) ??
    1_048_576;


  const context = resolveContext(agent?.context, limits.maxAgentContextBytes);
  const judgments = agent?.judgments ?? 'model';
  if (judgments !== 'model' && judgments !== 'executor') {
    throw new ConfigurationError('INVALID_CONFIG', "agent.judgments must be 'model' or 'executor'");
  }
  if (judgments === 'executor' && executor === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "agent.judgments 'executor' needs agent.executor to be set",
    );
  }
  const vision = agent?.vision ?? false;
  if (!isVisionMode(vision)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "agent.vision must be true, false, 'fallback', or 'only'",
    );
  }

  return {
    executor,
    model: resolveModel(agent?.model, env),
    visionModel: resolveModel(agent?.visionModel, env, 'agent.visionModel', 'E2E_VISION_MODEL'),
    maxSteps,
    maxModelCalls,
    maxObservationBytes,
    context,
    vision,
    judgments,
  };
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
        throw new ConfigurationError('INVALID_CONFIG', `unknown limits key "${key}"`);
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

/**
 * True when a config value is a live AI SDK language model instance. The check
 * is structural, exactly like the AI SDK's own model handling, so instances
 * from any realm or provider package are accepted.
 */
/** True for the closed `vision` value set, wherever it is supplied. */
export function isVisionMode(value: unknown): value is VisionMode {
  return typeof value === 'boolean' || value === 'fallback' || value === 'only';
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
 * Resolves one model reference from config or its environment override.
 *
 * `label` and `envName` are parameters because the same grammar serves
 * `agent.model` and `agent.visionModel`; every diagnostic then names the key the
 * author actually wrote. There is no implicit default model; an unconfigured
 * model fails at its first model call, so a custom-executor run needs none.
 */
function resolveModel(
  model: string | ModelConfig | ModelInstance | undefined,
  env: NodeJS.ProcessEnv,
  label = 'agent.model',
  envName = 'E2E_MODEL',
): ResolvedModel | undefined {
  if (model === undefined) {
    const fromEnv = env[envName];
    if (fromEnv === undefined || fromEnv.trim() === '') return undefined;
    return parseModelReference(fromEnv.trim(), envName, env);
  }
  if (typeof model === 'string') {
    return parseModelReference(model, label, env);
  }
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be "provider/model-id", a model object, or an AI SDK model instance`,
    );
  }
  if (isModelInstance(model)) {
    return {
      kind: 'instance',
      provider: model.provider,
      id: model.modelId,
      // Structurally verified above; the AI SDK duck-types models the same way.
      model: model as SdkLanguageModel,
    };
  }
  for (const key of Object.keys(model)) {
    if (!MODEL_KEYS.has(key)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown ${label} key "${key}"`);
    }
  }
  const provider = requireNonEmpty(model.provider, `${label}.provider`);
  const id = requireNonEmpty(model.id, `${label}.id`);
  return gatewayModel(provider, id, model.endpoint, model.apiKeyEnv, env);
}

/** Splits `provider/model-id` at the first slash. */
function parseModelReference(
  reference: string,
  label: string,
  env: NodeJS.ProcessEnv,
): ResolvedModel {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be "provider/model-id", got ${JSON.stringify(reference)}`,
    );
  }
  return gatewayModel(
    reference.slice(0, separator),
    reference.slice(separator + 1),
    undefined,
    undefined,
    env,
  );
}

function gatewayModel(
  provider: string,
  id: string,
  endpoint: string | undefined,
  apiKeyEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedModel {
  const keyEnv = validateApiKeyEnv(apiKeyEnv);
  const apiKey = firstNonEmpty(env[keyEnv], env[GATEWAY_API_KEY_ENV]);
  return {
    kind: 'gateway',
    provider,
    id,
    endpoint: validateEndpoint(endpoint),
    apiKeyEnv: keyEnv,
    apiKey,
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== '');
}

function validateEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConfigurationError('INVALID_CONFIG', `invalid agent.model.endpoint "${endpoint}"`);
  }
  if (parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return parsed.href;
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `agent.model.endpoint must use HTTPS unless it is a loopback host: ${endpoint}`,
  );
}

function validateApiKeyEnv(apiKeyEnv: string | undefined): string {
  if (apiKeyEnv === undefined) return DEFAULT_API_KEY_ENV;
  if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `agent.model.apiKeyEnv must be a valid environment variable name, got "${apiKeyEnv}"`,
    );
  }
  return apiKeyEnv;
}

function resolveContext(context: string | undefined, maxBytes: number): string | undefined {
  if (context === undefined) return undefined;
  if (typeof context !== 'string') {
    throw new ConfigurationError('INVALID_CONFIG', 'agent.context must be a string');
  }
  const bytes = new TextEncoder().encode(context).byteLength;
  if (bytes > maxBytes) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `agent.context is ${bytes} bytes; the resolved maximum is ${maxBytes}`,
    );
  }
  return context;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} is required`);
  }
  return value;
}

function boundedInt(
  value: number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an integer from ${min} through ${max}`,
    );
  }
  return value;
}
