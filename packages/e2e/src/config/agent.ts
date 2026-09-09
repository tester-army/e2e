/** Agent, model, and resource-limit resolution. */

import type { LanguageModel } from 'ai';
import { isStepExecutor, type StepExecutor } from '../agent/executor.ts';
import { boundedInt } from './validate.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { didYouMean } from '../internal/suggest.ts';
import { isLoopbackHost } from '../internal/urls.ts';
import type {
  AgentConfig,
  E2EConfig,
  ModelConfig,
  ModelInstance,
  ProviderOptions,
  VisionMode,
} from '../types.ts';

/** Default environment variable holding the provider credential. */
const DEFAULT_API_KEY_ENV = 'E2E_MODEL_API_KEY';

/** Gateway-native credential variable, used when apiKeyEnv holds no value. */
export const GATEWAY_API_KEY_ENV = 'AI_GATEWAY_API_KEY';

/** Environment override for the model endpoint; `agent.model.endpoint` wins over it. */
const MODEL_ENDPOINT_ENV = 'E2E_MODEL_ENDPOINT';

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
      /**
       * The variable the credential was read from: `apiKeyEnv`, else the
       * gateway's own `AI_GATEWAY_API_KEY`. A name, never a value, so a
       * rejected credential can be reported by where it came from.
       */
      readonly apiKeySource: string | undefined;
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
   * value itself (`agent: createAgent(...)` or any StepExecutor); undefined
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
  'visionModel',
  'maxSteps',
  'maxModelCalls',
  'maxObservationBytes',
  'context',
  'vision',
  'providerOptions',
]);

const MODEL_KEYS = new Set(['provider', 'id', 'endpoint', 'apiKeyEnv']);

/**
 * Default observation byte budget, shared with the report's pre-config fallback
 * limits. A quarter mebibyte of tree is already tens of thousands of tokens on
 * every act turn; the per-call token ceiling clamps a dense screen below it.
 */
export const DEFAULT_OBSERVATION_BYTES = 262_144;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Hard ceilings mirroring `schema/report-v1.schema.json` `limits`. */
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
        'agent must be an options object or the agent itself: createAgent(...) or any { name, runStep(context) }',
      );
    }
    for (const key of Object.keys(agent)) {
      if (!AGENT_KEYS.has(key)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown agent config key "${key}"${didYouMean(key, [...AGENT_KEYS])}`,
        );
      }
    }
    if (agent.executor !== undefined) {
      if (!isStepExecutor(agent.executor)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          'agent.executor must be a StepExecutor: createAgent(...) or any { name, runStep(context) }',
        );
      }
      executor = agent.executor;
    }
  }

  const maxSteps = boundedInt(agent?.maxSteps, 'agent.maxSteps', 1, 100) ?? 25;
  const maxModelCalls = boundedInt(agent?.maxModelCalls, 'agent.maxModelCalls', 1, 100) ?? 25;
  const maxObservationBytes =
    boundedInt(agent?.maxObservationBytes, 'agent.maxObservationBytes', 1_024, 16_777_216) ??
    DEFAULT_OBSERVATION_BYTES;


  const context = resolveContext(agent?.context, limits.maxAgentContextBytes);
  const vision = agent?.vision ?? false;
  if (!isVisionMode(vision)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "agent.vision must be true, false, 'fallback', or 'only'",
    );
  }

  return {
    executor,
    model: resolveCanonicalModel(agent?.model, executor?.model, env),
    visionModel: resolveModel(agent?.visionModel, env, 'agent.visionModel', 'E2E_VISION_MODEL'),
    maxSteps,
    maxModelCalls,
    maxObservationBytes,
    context,
    vision,
    providerOptions: resolveProviderOptions(agent?.providerOptions),
  };
}

/**
 * Validates `agent.providerOptions`: a record of provider names to option
 * records, the shape the AI SDK reads. Option values are the provider's own
 * business and pass through untouched.
 */
function resolveProviderOptions(value: unknown): ProviderOptions | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agent.providerOptions must be an object keyed by provider name',
    );
  }
  for (const [provider, options] of Object.entries(value)) {
    if (!isPlainObject(options)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `agent.providerOptions.${provider} must be an object of provider options`,
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
 * The one model both tiers use. The model the executor brought
 * (`createAgent({ model })`) is it; without one, `agent.model`, then
 * `E2E_MODEL`. An `agent.model` naming a different model than the executor's
 * is rejected: two configured models would split the tiers silently.
 */
function resolveCanonicalModel(
  configured: string | ModelConfig | ModelInstance | undefined,
  executorModel: ModelInstance | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedModel | undefined {
  if (executorModel === undefined) return resolveModel(configured, env);
  const own: ResolvedModel = {
    kind: 'instance',
    provider: executorModel.provider,
    id: executorModel.modelId,
    model: asSdkLanguageModel(executorModel),
  };
  if (configured === undefined) return own;
  const explicit = resolveModel(configured, env);
  if (explicit !== undefined && (explicit.provider !== own.provider || explicit.id !== own.id)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `agent.model (${explicit.provider}/${explicit.id}) and the executor's own model (${own.provider}/${own.id}) differ; configure the model in one place`,
    );
  }
  return own;
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
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown ${label} key "${key}"${didYouMean(key, [...MODEL_KEYS])}`,
      );
    }
  }
  const provider = requireNonEmpty(model.provider, `${label}.provider`);
  const id = requireNonEmpty(model.id, `${label}.id`);
  return gatewayModel(provider, id, model.endpoint, model.apiKeyEnv, env, label);
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
    label,
  );
}

function gatewayModel(
  provider: string,
  id: string,
  endpoint: string | undefined,
  apiKeyEnv: string | undefined,
  env: NodeJS.ProcessEnv,
  label: string,
): ResolvedModel {
  const keyEnv = validateApiKeyEnv(apiKeyEnv, label);
  const apiKeySource = [keyEnv, GATEWAY_API_KEY_ENV].find((name) => {
    const value = env[name];
    return value !== undefined && value.trim() !== '';
  });
  return {
    kind: 'gateway',
    provider,
    id,
    endpoint: resolveEndpoint(endpoint, env, label),
    apiKeyEnv: keyEnv,
    apiKeySource,
    apiKey: apiKeySource === undefined ? undefined : env[apiKeySource],
  };
}

/**
 * The endpoint from config when set, else `E2E_MODEL_ENDPOINT`, else undefined
 * for the gateway default. Diagnostics name whichever source supplied the value.
 */
function resolveEndpoint(
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv,
  label: string,
): string | undefined {
  if (endpoint !== undefined) return validateEndpoint(endpoint, `${label}.endpoint`);
  const fromEnv = env[MODEL_ENDPOINT_ENV]?.trim();
  if (fromEnv === undefined || fromEnv === '') return undefined;
  return validateEndpoint(fromEnv, MODEL_ENDPOINT_ENV);
}

function validateEndpoint(endpoint: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConfigurationError('INVALID_CONFIG', `invalid ${name} "${endpoint}"`);
  }
  if (parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return parsed.href;
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `${name} must use HTTPS unless it is a loopback host: ${endpoint}`,
  );
}

function validateApiKeyEnv(apiKeyEnv: string | undefined, label: string): string {
  if (apiKeyEnv === undefined) return DEFAULT_API_KEY_ENV;
  if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label}.apiKeyEnv must be a valid environment variable name, got "${apiKeyEnv}"`,
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
