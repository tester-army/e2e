/** Agent, model, and resource-limit resolution (spec 05-config.md, 14-security.md). */

import { ConfigurationError } from '../internal/errors.ts';
import { isLoopbackHost } from '../internal/urls.ts';
import type { E2EConfig, ModelConfig } from '../types.ts';

/** Default environment variable holding the provider credential. */
export const DEFAULT_API_KEY_ENV = 'E2E_MODEL_API_KEY';

/**
 * Resolved model identity. The credential itself is never resolved here; only
 * the name of the variable that holds it (14-security.md).
 */
export interface ResolvedModel {
  readonly provider: string;
  readonly id: string;
  /** Absolute endpoint override, or undefined for the adapter default. */
  readonly endpoint: string | undefined;
  readonly apiKeyEnv: string;
}

export interface ResolvedAgentConfig {
  /** Undefined until a model is configured; acquiring `agent` then fails. */
  readonly model: ResolvedModel | undefined;
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxObservationBytes: number;
  readonly cache: 'off' | 'read-only' | 'read-write';
  readonly context: string | undefined;
}

export interface ResolvedLimits {
  readonly maxDiscoveredResults: number;
  readonly maxCacheBytes: number;
  readonly maxTerminalFieldBytes: number;
  readonly maxAgentContextBytes: number;
  readonly maxLedgerBytes: number;
  readonly maxObservationBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxArtifactTotalBytes: number;
  readonly maxDownloadBytes: number;
  readonly maxDownloads: number;
  readonly maxReportBytes: number;
  readonly maxEventsPerStep: number;
  readonly maxModelTokensPerCall: number;
  readonly maxModelCallsPerStep: number;
  readonly maxActionStepsPerStep: number;
  readonly maxEstimatedCostUsd: number | undefined;
}

const AGENT_KEYS = new Set([
  'model',
  'maxSteps',
  'maxModelCalls',
  'maxObservationBytes',
  'cache',
  'context',
]);

const MODEL_KEYS = new Set(['provider', 'id', 'endpoint', 'apiKeyEnv']);

const CACHE_MODES = new Set(['off', 'read-only', 'read-write']);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Hard ceilings mirroring spec/schema/report-v1.schema.json `limits`. */
const LIMIT_BOUNDS = {
  maxDiscoveredResults: [1, 1_000_000, 100_000],
  maxCacheBytes: [1_024, 1_048_576, 262_144],
  maxTerminalFieldBytes: [1_024, 65_536, 8_192],
  maxAgentContextBytes: [1_024, 65_536, 16_384],
  maxLedgerBytes: [1_024, 65_536, 8_192],
  maxArtifactBytes: [1, 1_073_741_824, 104_857_600],
  maxArtifactTotalBytes: [1, 10_737_418_240, 1_073_741_824],
  maxDownloadBytes: [1, 1_073_741_824, 104_857_600],
  maxDownloads: [0, 100, 10],
  maxReportBytes: [1, 104_857_600, 52_428_800],
  maxEventsPerStep: [1, 10_000, 1_000],
  maxModelTokensPerCall: [1, 1_000_000, 64_000],
  maxModelCallsPerStep: [1, 100, 25],
  maxActionStepsPerStep: [1, 100, 25],
} as const satisfies Record<string, readonly [number, number, number]>;

type LimitKey = keyof typeof LIMIT_BOUNDS;

/** Resolves `config.agent` plus model environment fallbacks. */
export function resolveAgentConfig(
  raw: E2EConfig,
  env: NodeJS.ProcessEnv,
  ci: boolean,
  cacheOverride: 'off' | undefined,
): ResolvedAgentConfig {
  const agent = raw.agent;
  if (agent !== undefined) {
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
      throw new ConfigurationError('INVALID_CONFIG', 'agent must be an object');
    }
    for (const key of Object.keys(agent)) {
      if (!AGENT_KEYS.has(key)) {
        throw new ConfigurationError('INVALID_CONFIG', `unknown agent config key "${key}"`);
      }
    }
  }

  const maxSteps = boundedInt(agent?.maxSteps, 'agent.maxSteps', 1, 100) ?? 25;
  const maxModelCalls = boundedInt(agent?.maxModelCalls, 'agent.maxModelCalls', 1, 100) ?? 25;
  const maxObservationBytes =
    boundedInt(agent?.maxObservationBytes, 'agent.maxObservationBytes', 1_024, 16_777_216) ??
    1_048_576;

  let cache = agent?.cache ?? (ci ? 'read-only' : 'read-write');
  if (!CACHE_MODES.has(cache)) {
    throw new ConfigurationError('INVALID_CONFIG', `invalid agent.cache mode "${cache}"`);
  }
  if (cacheOverride === 'off') cache = 'off';

  const context = resolveContext(agent?.context, raw.limits?.maxAgentContextBytes ?? 16_384);

  return {
    model: resolveModel(agent?.model, env),
    maxSteps,
    maxModelCalls,
    maxObservationBytes,
    cache,
    context,
  };
}

/** Resolves the `limits` block; observation bytes come from `agent`. */
export function resolveLimits(raw: E2EConfig, maxObservationBytes: number): ResolvedLimits {
  const limits = raw.limits;
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      throw new ConfigurationError('INVALID_CONFIG', 'limits must be an object');
    }
    for (const key of Object.keys(limits)) {
      if (!(key in LIMIT_BOUNDS) && key !== 'maxEstimatedCostUsd') {
        throw new ConfigurationError('INVALID_CONFIG', `unknown limits key "${key}"`);
      }
    }
  }

  const resolved: Record<string, number> = {};
  for (const key of Object.keys(LIMIT_BOUNDS) as LimitKey[]) {
    const [min, max, fallback] = LIMIT_BOUNDS[key];
    resolved[key] = boundedInt(limits?.[key], `limits.${key}`, min, max) ?? fallback;
  }

  const cost = limits?.maxEstimatedCostUsd;
  if (cost !== undefined && (!Number.isFinite(cost) || cost <= 0)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'limits.maxEstimatedCostUsd must be a finite positive number',
    );
  }

  return {
    ...(resolved as unknown as Omit<ResolvedLimits, 'maxObservationBytes' | 'maxEstimatedCostUsd'>),
    maxObservationBytes,
    maxEstimatedCostUsd: cost,
  };
}

/**
 * Resolves the model from config or `E2E_MODEL`. There is no implicit default
 * model; an unconfigured agent fails at fixture acquisition.
 */
function resolveModel(
  model: string | ModelConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedModel | undefined {
  if (model === undefined) {
    const fromEnv = env['E2E_MODEL'];
    if (fromEnv === undefined || fromEnv.trim() === '') return undefined;
    return parseModelReference(fromEnv.trim(), 'E2E_MODEL', undefined, undefined);
  }
  if (typeof model === 'string') {
    return parseModelReference(model, 'agent.model', undefined, undefined);
  }
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agent.model must be "provider/model-id" or a model object',
    );
  }
  for (const key of Object.keys(model)) {
    if (!MODEL_KEYS.has(key)) {
      throw new ConfigurationError('INVALID_CONFIG', `unknown agent.model key "${key}"`);
    }
  }
  const provider = requireNonEmpty(model.provider, 'agent.model.provider');
  const id = requireNonEmpty(model.id, 'agent.model.id');
  return {
    provider,
    id,
    endpoint: validateEndpoint(model.endpoint),
    apiKeyEnv: validateApiKeyEnv(model.apiKeyEnv),
  };
}

/** Splits `provider/model-id` at the first slash. */
function parseModelReference(
  reference: string,
  label: string,
  endpoint: string | undefined,
  apiKeyEnv: string | undefined,
): ResolvedModel {
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be "provider/model-id", got ${JSON.stringify(reference)}`,
    );
  }
  return {
    provider: reference.slice(0, separator),
    id: reference.slice(separator + 1),
    endpoint: validateEndpoint(endpoint),
    apiKeyEnv: validateApiKeyEnv(apiKeyEnv),
  };
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
