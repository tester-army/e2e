/** Agent, model, and resource-limit resolution. */

import { isStepExecutor, type StepExecutor } from '../agent/executor.ts';
import { GRAMMAR_TOOL_NAMES, HARNESS_TOOL_NAMES } from '../agent/action-names.ts';
import { AgentError } from '../agent/error.ts';
import { isDefinedTool } from '../agent/tool.ts';
import { boundedInt, positiveInt } from './validate.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { didYouMean } from '../internal/suggest.ts';
import type {
  AgentConfig,
  AgentTool,
  ModelInstance,
  ProviderOptions,
  VisionMode,
} from '../types.ts';

/**
 * Resolved model identity: a caller-supplied AI SDK model instance
 * (`gateway('openai/gpt-6-luna-fast')`, `openrouter(...)`, `openai(...)`, any
 * `LanguageModelV2+`) and the provider and id it reports. The instance owns
 * its own transport and credentials; the runner constructs no model of its
 * own and reads no model variable from the environment. Instances never cross
 * a process boundary: workers re-resolve the config module and construct
 * their own.
 */
export interface ResolvedModel {
  readonly provider: string;
  readonly id: string;
  /**
   * The instance, structurally typed. `asSdkLanguageModel` narrows it at the
   * AI SDK boundary, so this module and the config types built on it name
   * nothing from the optional `ai` peer.
   */
  readonly model: ModelInstance;
}

/** A resolved model as reports and diagnostics name it: the instance's `provider/model-id`. */
export function modelLabel(model: ResolvedModel): string {
  return `${model.provider}/${model.id}`;
}

export interface ResolvedAgentConfig {
  /**
   * The custom brain `agent.act()` dispatches to (`agents.<name>.executor`);
   * undefined selects the built-in agent, built at fixture time from
   * `system` and `tools`. Like model instances, an executor never crosses a
   * process boundary: workers re-resolve the config module.
   */
  readonly executor: StepExecutor | undefined;
  /** Undefined until a model is configured; acquiring `agent` then fails. */
  readonly model: ResolvedModel | undefined;
  /**
   * The judgment tier's model: `judge`, or the executor's own judge, when one
   * is configured (both set must agree), else `model`. Undefined only when no
   * model is configured at all, so downstream code has one rule: judgments
   * call `judge`.
   */
  readonly judge: ResolvedModel | undefined;
  /** The built-in agent's guidance, appended to its execution rules; undefined with a custom executor. */
  readonly system: string | undefined;
  /** The built-in agent's project tools, validated; empty with a custom executor. */
  readonly tools: Readonly<Record<string, AgentTool>>;
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  /** Deadline of one judgment-tier call (`assert`, `waitFor`, `extract`), in milliseconds. */
  readonly judgmentTimeout: number;
  readonly maxObservationBytes: number;
  /** Input tokens one model request of this agent may carry; observations are clamped under it. */
  readonly maxInputTokens: number;
  readonly context: string | undefined;
  /**
   * Provider options sent with every model call, judgments included. This is
   * how a reasoning model's effort is lowered project-wide; an executor that
   * carries its own options keeps them.
   */
  readonly providerOptions: ProviderOptions | undefined;
}

/**
 * The run's resource ceilings, the report's `limits` block: the per-agent
 * ones at the largest any configured agent may use, the rest the runner's
 * fixed internal limits.
 */
export interface ResolvedLimits {
  readonly maxAgentContextBytes: number;
  readonly maxLedgerBytes: number;
  readonly maxObservationBytes: number;
  readonly maxEventsPerStep: number;
  readonly maxModelTokensPerCall: number;
}

const AGENT_KEYS = [
  'model',
  'judge',
  'system',
  'context',
  'tools',
  'executor',
  'maxSteps',
  'maxModelCalls',
  'judgmentTimeout',
  'maxObservationBytes',
  'maxInputTokens',
  'providerOptions',
] as const;

const AGENT_KEY_SET: ReadonlySet<string> = new Set(AGENT_KEYS);

/** Agent keys this runner used to accept, each mapped to what replaces it. */
const REMOVED_AGENT_KEYS: ReadonlyMap<string, string> = new Map([
  ['timeout', 'use judgmentTimeout, the deadline of one assert, waitFor, or extract call'],
  ['maxTurns', 'use maxModelCalls, the model requests one agent call may make'],
  ['maxModelTokensPerCall', 'use maxInputTokens'],
  ['limits', 'set maxInputTokens on the agent; the runner fixes the other limits'],
]);

/** The keys only the built-in agent reads; a custom executor brings its own. */
const BUILT_IN_ONLY_KEYS = ['system', 'tools'] as const;

/** The shape an agents entry takes, for messages that point at it. */
const AGENT_SHAPE = '{ model, judge, system, context, tools, maxSteps, maxModelCalls, ... }';

/**
 * Default observation byte budget. A quarter mebibyte of tree is already tens
 * of thousands of tokens on every act turn; the per-call token ceiling clamps
 * a dense screen below it.
 */
const DEFAULT_OBSERVATION_BYTES = 262_144;

/** Default per-request input token ceiling; `maxInputTokens` moves it per agent. */
const DEFAULT_INPUT_TOKENS = 64_000;

/** Trusted agent context, config and test context joined, in bytes. */
const MAX_AGENT_CONTEXT_BYTES = 16_384;
/** The prior-step ledger an act step reads, in bytes. */
const MAX_LEDGER_BYTES = 8_192;
/** Events recorded per step; later ones are dropped. */
const MAX_EVENTS_PER_STEP = 1_000;

/**
 * Default judgment budget: one observation and one or two model calls. The
 * agent's own knob, deliberately apart from `actionTimeout`, so a slow judge
 * never inflates the engine's per-operation budget.
 */
const DEFAULT_JUDGMENT_TIMEOUT_MS = 30_000;

/** The limits of a run no agent config has shaped: every value at its default. */
export const DEFAULT_LIMITS: ResolvedLimits = {
  maxAgentContextBytes: MAX_AGENT_CONTEXT_BYTES,
  maxLedgerBytes: MAX_LEDGER_BYTES,
  maxObservationBytes: DEFAULT_OBSERVATION_BYTES,
  maxEventsPerStep: MAX_EVENTS_PER_STEP,
  maxModelTokensPerCall: DEFAULT_INPUT_TOKENS,
};

/**
 * The run's limits over its configured agents. A pinned agent's calls are
 * bounded by its own values, so the run-level number is the largest any
 * agent may use: the report must not read lower than what a step could
 * actually send.
 */
export function runLimits(agents: Iterable<ResolvedAgentConfig>): ResolvedLimits {
  const all = [...agents];
  if (all.length === 0) return DEFAULT_LIMITS;
  return {
    ...DEFAULT_LIMITS,
    maxObservationBytes: Math.max(...all.map((agent) => agent.maxObservationBytes)),
    maxModelTokensPerCall: Math.max(...all.map((agent) => agent.maxInputTokens)),
  };
}

/**
 * Resolves one `agents` entry. Every entry starts from the built-in defaults:
 * nothing is inherited from another agent, `default` included.
 */
export function resolveAgentConfig(
  value: AgentConfig | undefined,
  /** The config path of this agent in diagnostics: `agents.default`, `agents.ux`. */
  label = 'agents.default',
): ResolvedAgentConfig {
  const agent = checkAgentShape(value, label);
  let executor: StepExecutor | undefined;
  if (agent?.executor !== undefined) {
    executor = checkExecutor(agent.executor, `${label}.executor`);
    for (const key of BUILT_IN_ONLY_KEYS) {
      if (agent[key] === undefined) continue;
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${label}.${key} is an option of the built-in agent, and ${label}.executor replaces it: a custom executor brings its own ${key === 'system' ? 'prompt' : 'tools'}; drop ${key} or drop executor`,
      );
    }
  }

  const maxSteps = boundedInt(agent?.maxSteps, `${label}.maxSteps`, 1, 100) ?? 25;
  const maxModelCalls = boundedInt(agent?.maxModelCalls, `${label}.maxModelCalls`, 1, 100) ?? 25;
  const judgmentTimeout =
    positiveInt(agent?.judgmentTimeout, `${label}.judgmentTimeout`, 'milliseconds') ?? DEFAULT_JUDGMENT_TIMEOUT_MS;
  const maxObservationBytes =
    boundedInt(agent?.maxObservationBytes, `${label}.maxObservationBytes`, 1_024, 16_777_216) ??
    DEFAULT_OBSERVATION_BYTES;
  const maxInputTokens =
    boundedInt(agent?.maxInputTokens, `${label}.maxInputTokens`, 1, 1_000_000) ?? DEFAULT_INPUT_TOKENS;

  const model = resolveCanonicalModel(agent?.model, executor?.model, label, 'model');
  return {
    executor,
    model,
    judge: resolveCanonicalModel(agent?.judge, executor?.judge, label, 'judge') ?? model,
    system: resolveSystem(agent?.system, label),
    tools: resolveTools(agent?.tools, label),
    maxSteps,
    maxModelCalls,
    judgmentTimeout,
    maxObservationBytes,
    maxInputTokens,
    context: validateContext(agent?.context, `${label}.context`),
    providerOptions: resolveProviderOptions(agent?.providerOptions, label),
  };
}

/**
 * The entry as a plain options object, or a diagnostic naming the shape it
 * should have: a bare executor goes under `executor`, and a removed key
 * names its replacement.
 */
function checkAgentShape(value: unknown, label: string): AgentConfig | undefined {
  if (value === undefined) return undefined;
  if (isStepExecutor(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} is a StepExecutor (${JSON.stringify(value.name)}); an agents entry is an options object now, so pass it as ${label}: { executor, model, ... }`,
    );
  }
  if (looksLikeModel(value)) {
    const { provider, modelId } = value as { provider?: unknown; modelId: string };
    const named = typeof provider === 'string' ? `${provider}/${modelId}` : modelId;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} is a model instance (${named}); an agents entry is an options object, so write ${label}: { model: ... } with it`,
    );
  }
  if (!isPlainObject(value)) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be an options object: ${label}: ${AGENT_SHAPE}`);
  }
  for (const key of Object.keys(value)) {
    const removed = REMOVED_AGENT_KEYS.get(key);
    if (removed !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `${label}.${key} was removed: ${removed}`);
    }
    if (!AGENT_KEY_SET.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `unknown ${label} key "${key}"${didYouMean(key, AGENT_KEYS)}`,
      );
    }
  }
  return value as AgentConfig;
}

/**
 * Whether a value reads as an AI SDK model instance, loosely: what a model
 * put where an agents entry goes carries, with or without a `doGenerate` a
 * wrapper hides, so the entry's own key check never reports its fields.
 */
function looksLikeModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['specificationVersion'] === 'string' && typeof candidate['modelId'] === 'string';
}

/**
 * `MODEL_UNAVAILABLE` for the agent `name`, whose entry holds no model:
 * what needs it (`needs`, the agent fixture by default), and the entry to
 * write, under that agent's own key.
 */
export function missingModelError(name: string, needs = 'the agent fixture requires a model'): AgentError {
  const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  return new AgentError(
    'MODEL_UNAVAILABLE',
    `${needs}, and agents.${name} has none: set model on it to an AI SDK model instance, e.g. agents: { ${key}: { model: gateway('openai/gpt-6-luna-fast') } }`,
  );
}

/** A custom brain: any `StepExecutor`. */
function checkExecutor(value: unknown, label: string): StepExecutor {
  if (!isStepExecutor(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be a StepExecutor: any { name, runStep(context) }, such as createToolLoopExecutor(...) from e2e/agent`,
    );
  }
  return value;
}

/** The built-in agent's guidance: a string, as JavaScript can pass anything. */
function resolveSystem(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.system must be a string`);
  }
  return value;
}

const NO_TOOLS: Readonly<Record<string, AgentTool>> = Object.freeze({});

/**
 * Validates the built-in agent's project tools: each from `defineTool`, with
 * an execute function, under a name the agent's own tools do not hold. A
 * shadowed name would be a tool the model never sees on one engine and a
 * different one on another.
 */
function resolveTools(value: unknown, label: string): Readonly<Record<string, AgentTool>> {
  if (value === undefined) return NO_TOOLS;
  if (!isPlainObject(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label}.tools must be an object of tools by name, each from defineTool`,
    );
  }
  for (const [name, defined] of Object.entries(value)) {
    const key = `${label}.tools.${name}`;
    if (!isDefinedTool(defined)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${key} was not created with defineTool; undeclared semantics are not trusted`,
      );
    }
    if (GRAMMAR_TOOL_NAMES.has(name)) {
      throw new ConfigurationError('INVALID_CONFIG', `${key}: the ${name} tool name is reserved for the agent's own tools`);
    }
    const harness = HARNESS_TOOL_NAMES.get(name);
    if (harness !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `${key}: the ${name} tool name is reserved for the tool the harness adds in ${harness}; rename it`);
    }
    if (typeof defined.tool.execute !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `${key} has no execute function`);
    }
  }
  return value as Readonly<Record<string, AgentTool>>;
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

/** True for the closed judgment `vision` value set, wherever it is supplied. */
function isVisionMode(value: unknown): value is VisionMode {
  return typeof value === 'boolean' || value === 'only';
}

/** A judgment's `vision` option as called: the tree unless the call asks for pixels; anything else is INVALID_ARGUMENT. */
export function resolveVision(requested: unknown): VisionMode {
  if (requested === undefined) return false;
  if (!isVisionMode(requested)) throw new TestError('INVALID_ARGUMENT', "vision must be true, false, or 'only'");
  return requested;
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
 * One model per slot. The model a custom executor brought (its `model` or
 * `judge`) is it; without one, the agent's own key. A config key naming a
 * different model than the executor's is rejected: two configured models for
 * one slot would split the run silently.
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
function resolveModel(model: ModelInstance | undefined, label: string): ResolvedModel | undefined {
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
      `${label} must be an AI SDK model instance, e.g. gateway('openai/gpt-6-luna-fast') from 'ai'`,
    );
  }
  return { provider: model.provider, id: model.modelId, model };
}

/** The agent's app vocabulary: a string within the trusted context budget. */
function validateContext(context: unknown, label: string): string | undefined {
  if (context === undefined) return undefined;
  if (typeof context !== 'string') {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be a string`);
  }
  const bytes = new TextEncoder().encode(context).byteLength;
  if (bytes > MAX_AGENT_CONTEXT_BYTES) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} is ${bytes} bytes; the maximum is ${MAX_AGENT_CONTEXT_BYTES}`,
    );
  }
  return context;
}
