/**
 * Vercel AI SDK adapter. Every provider is reached through the AI Gateway, so
 * switching provider is a model-string change (`agent.model: 'anthropic/...'`).
 * `agent.model.endpoint` overrides the gateway base URL for self-hosted or
 * proxied deployments.
 */

import {
  APICallError,
  createGateway,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
} from 'ai';
import type { ResolvedModel } from '../../config/agent.ts';
import { packageVersion } from '../../internal/package-version.ts';
import { AgentError } from '../error.ts';
import {
  ModelOutputInvalidError,
  tokenUpperBound,
  type ModelAdapter,
  type ModelCall,
  type ModelResult,
  type ModelUsage,
} from './adapter.ts';

/** Default AI Gateway base URL used when no endpoint override is configured. */
const DEFAULT_GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai';

/** Gateway-native credential variable, used when apiKeyEnv is unset. */
const GATEWAY_API_KEY_ENV = 'AI_GATEWAY_API_KEY';

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Provider transport retries; distinct from runner-owned model-call budget. */
const TRANSPORT_RETRIES = 2;

/** Creates the AI Gateway adapter for one resolved model. */
export function createGatewayAdapter(
  model: ResolvedModel,
  env: NodeJS.ProcessEnv,
): ModelAdapter {
  if (!PROVIDER_PATTERN.test(model.provider)) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      `unknown model provider "${model.provider}"; expected a gateway provider ID`,
    );
  }
  const apiKey = env[model.apiKeyEnv] ?? env[GATEWAY_API_KEY_ENV];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      `no model credential: set ${model.apiKeyEnv} or ${GATEWAY_API_KEY_ENV}`,
    );
  }
  const endpoint = model.endpoint ?? DEFAULT_GATEWAY_ENDPOINT;
  const gateway = createGateway({
    apiKey,
    ...(model.endpoint !== undefined ? { baseURL: model.endpoint } : {}),
  });
  const modelId = `${model.provider}/${model.id}`;
  const languageModel = gateway.languageModel(modelId);
  const adapterVersion = packageVersion(import.meta.url, '../../../package.json', '0.0.0');

  return {
    provenance: {
      provider: model.provider,
      model: model.id,
      endpoint,
      adapterVersion: `ai-gateway/${adapterVersion}`,
    },
    async generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>> {
      const inputBound = tokenUpperBound(call.system) + tokenUpperBound(call.prompt);
      if (inputBound > call.maxInputTokens) {
        throw new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `model input upper bound ${inputBound} exceeds limits.maxModelTokensPerCall ${call.maxInputTokens}`,
        );
      }
      let issue: string | undefined;
      const schema = call.schema;
      const settings = {
        model: languageModel,
        system: call.system,
        prompt: call.prompt,
        maxOutputTokens: call.maxOutputTokens,
        temperature: 0,
        maxRetries: TRANSPORT_RETRIES,
        abortSignal: call.signal,
        timeout: call.timeoutMs,
      } as const;
      try {
        if (schema === undefined) {
          const result = await generateText(settings);
          const parsed = parseJsonObject(result.text);
          const validation = call.validate(parsed);
          if (!validation.ok) {
            throw new ModelOutputInvalidError(validation.issue, { rawText: result.text });
          }
          return { value: validation.value, usage: readUsage(result, inputBound) };
        }
        const result = await generateText({
          ...settings,
          output: Output.object({
            schema: jsonSchema<Value>(schema, {
              validate: (value: unknown) => {
                const validation = call.validate(value);
                if (validation.ok) return { success: true as const, value: validation.value };
                issue = validation.issue;
                return { success: false as const, error: new Error(validation.issue) };
              },
            }),
            name: call.schemaName,
          }),
        });
        const output = result.output;
        if (output === undefined) {
          throw new ModelOutputInvalidError('provider returned no structured output');
        }
        return { value: output, usage: readUsage(result, inputBound) };
      } catch (cause) {
        throw translateModelError(cause, issue, call.signal);
      }
    },
  };
}

interface UsageCarrier {
  readonly usage?: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined } | undefined;
  readonly text?: string | undefined;
  readonly providerMetadata?:
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>
    | undefined;
}

function readUsage(result: UsageCarrier, inputBound: number): ModelUsage {
  const inputTokens = result.usage?.inputTokens;
  const outputTokens = result.usage?.outputTokens;
  const estimatedCostUsd = readCost(result.providerMetadata);
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    return { inputTokens, outputTokens, accounting: 'provider', estimatedCostUsd };
  }
  return {
    inputTokens: inputBound,
    outputTokens: tokenUpperBound(result.text ?? ''),
    accounting: 'adapter-upper-bound',
    estimatedCostUsd,
  };
}

/**
 * Parses exactly one JSON object from response text, tolerating a code fence.
 * Model text is never evaluated as code.
 */
function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new ModelOutputInvalidError('response text is not a single JSON value', {
      rawText: text,
      cause,
    });
  }
}

/**
 * AI Gateway reports per-request cost in provider metadata when available.
 * `cost` is what the gateway bills; BYOK routes bill the provider key directly
 * and report `cost: "0"`, so fall back to `marketCost`, the list-price
 * estimate of the same request.
 */
function readCost(
  metadata: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): number | undefined {
  const billed = parseCost(metadata?.['gateway']?.['cost']);
  if (billed !== undefined && billed > 0) return billed;
  return parseCost(metadata?.['gateway']?.['marketCost']) ?? billed;
}

function parseCost(raw: unknown): number | undefined {
  const cost = typeof raw === 'string' ? Number(raw) : raw;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/** Maps adapter and provider failures onto the closed agent error set. */
function translateModelError(cause: unknown, issue: string | undefined, signal: AbortSignal): Error {
  if (cause instanceof AgentError) return cause;
  // Only an aborted attempt is a cancellation. A request that exceeded the
  // remaining step budget is a timeout, which is a test failure (06-cli.md).
  if (signal.aborted) {
    return new AgentError('CANCELLED', 'model call cancelled', { cause });
  }
  if (isAbort(cause)) {
    return new AgentError(
      'STEP_TIMEOUT',
      'model call exceeded the remaining step timeout',
      { cause },
    );
  }
  if (NoObjectGeneratedError.isInstance(cause)) {
    return new ModelOutputInvalidError(
      issue ?? 'provider response did not match the closed response grammar',
      { ...(cause.text !== undefined ? { rawText: cause.text } : {}), cause },
    );
  }
  if (APICallError.isInstance(cause)) {
    return new AgentError('MODEL_PROVIDER_FAILED', `model provider failed: ${cause.message}`, {
      cause,
    });
  }
  return new AgentError(
    'MODEL_PROVIDER_FAILED',
    `model provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}
