/**
 * AI SDK adapter. One implementation serves every provider: the
 * caller-supplied AI SDK model instance (`gateway('openai/gpt-5.6-luna')`,
 * `openrouter(...)`, `openai('gpt-4o')`, a local provider, a scripted test
 * model) is used as is. Everything after the model — bounded requests,
 * closed-grammar validation, usage and error translation — is
 * provider-independent.
 */

import type { ModelMessage } from 'ai';
import { withHint } from '../../internal/errors.ts';
import type { ResolvedModel, SdkLanguageModel } from '../../config/agent.ts';
import { aiSdk, loadAiSdk } from '../ai-sdk.ts';
import { packageVersion } from '../../internal/package-version.ts';
import { AgentError } from '../error.ts';
import { isContextOverflow } from './overflow.ts';
import { promptCacheHints, type CacheModelRef } from './prompt-cache.ts';
import {
  imageTokenUpperBound,
  ModelOutputInvalidError,
  tokenUpperBound,
  type ModelAdapter,
  type ModelCall,
  type ModelImage,
  type ModelResult,
  type ModelUsage,
} from './adapter.ts';

/**
 * Provider transport retries; distinct from runner-owned model-call budget.
 *
 * Rate limits and 5xx bursts are the dominant cause of spurious agent-step
 * failures, and the SDK only retries errors the provider marked retryable,
 * honoring `retry-after` before its own exponential backoff. Raising the SDK
 * default of 2 costs nothing on a healthy provider: `timeout` below is merged
 * into the signal the retry loop waits on, so the step deadline — not the
 * attempt count — bounds the whole chain. The act loop sends the same count
 * and the same kind of timeout, so both tiers fail a flaky provider alike.
 */
export const TRANSPORT_RETRIES = 5;

/** Creates the adapter for one resolved model, or fails with MODEL_UNAVAILABLE. */
export function createModelAdapter(model: ResolvedModel | undefined): ModelAdapter {
  if (model === undefined) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      'the agent fixture requires a model: pass an AI SDK model instance to createAgent({ model }) or set agent.model',
    );
  }
  const adapterVersion = packageVersion(import.meta.url, '../../../package.json', '0.0.0');
  const languageModel = model.model;

  return {
    provenance: {
      provider: model.provider,
      model: model.id,
      // The instance owns its transport; the report records that the endpoint
      // is whatever the provider package was configured with.
      endpoint: 'provider-default',
      adapterVersion: `ai-sdk/${adapterVersion}`,
    },
    async generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>> {
      const { generateText, jsonSchema, Output } = await loadAiSdk();
      const cache = promptCacheHints(languageModel as CacheModelRef);
      const images = call.images ?? [];
      const inputBound =
        tokenUpperBound(call.system) +
        tokenUpperBound(call.prompt) +
        images.reduce((total, image) => total + imageTokenUpperBound(image), 0);
      if (inputBound > call.maxInputTokens) {
        throw new AgentError(
          'STEP_BUDGET_EXHAUSTED',
          `model input upper bound ${inputBound} exceeds limits.maxModelTokensPerCall ${call.maxInputTokens}`,
        );
      }
      let issue: string | undefined;
      const schema = call.schema;
      // The policy prefix is what every judgment call of a run shares, so it
      // is where the prompt cache is addressed; the prompt itself is one-off.
      const providerOptions = cache.providerOptions(call.providerOptions, call.system);
      const settings = {
        model: languageModel,
        instructions: cache.instructions(call.system),
        // Text-only calls keep the plain prompt form; images require the
        // multi-part message form, and both must carry the same instruction
        // text in the same position relative to the system policy.
        ...(images.length === 0
          ? { prompt: call.prompt }
          : { messages: [userMessage(call.prompt, images)] }),
        maxOutputTokens: call.maxOutputTokens,
        ...(providerOptions === undefined ? {} : { providerOptions: providerOptions as never }),
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

/**
 * Builds the one user message of a vision call: instruction text first, then
 * the image parts it refers to, so the text framing the pixels as data is read
 * before them.
 */
function userMessage(prompt: string, images: readonly ModelImage[]): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      // A file part with an image media type, not the deprecated `image` part.
      ...images.map((image) => ({
        type: 'file' as const,
        data: image.data,
        mediaType: image.mediaType,
      })),
    ],
  };
}

/**
 * The bare AI SDK language model of one resolved model, for callers that
 * drive the SDK directly (the default step executor) rather than through the
 * adapter.
 */
export function instantiateLanguageModel(model: ResolvedModel): SdkLanguageModel {
  return model.model;
}

interface UsageCarrier {
  readonly usage?: SdkUsage | undefined;
  readonly text?: string | undefined;
  readonly providerMetadata?:
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>
    | undefined;
}

/** The AI SDK usage fields the runner reads, structurally. */
export interface SdkUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly inputTokenDetails?:
    | {
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
      }
    | undefined;
}

/**
 * The prompt-cache split of one call's input, when the provider reported it.
 * Providers that cache nothing report zeros; providers that do not report the
 * split leave the fields undefined, and so does the report.
 */
export function cacheTokenFields(
  usage: SdkUsage | undefined,
): { cacheReadTokens?: number; cacheWriteTokens?: number } {
  const details = usage?.inputTokenDetails;
  return {
    ...(typeof details?.cacheReadTokens === 'number' ? { cacheReadTokens: details.cacheReadTokens } : {}),
    ...(typeof details?.cacheWriteTokens === 'number' ? { cacheWriteTokens: details.cacheWriteTokens } : {}),
  };
}

function readUsage(result: UsageCarrier, inputBound: number): ModelUsage {
  const inputTokens = result.usage?.inputTokens;
  const outputTokens = result.usage?.outputTokens;
  const estimatedCostUsd = readCost(result.providerMetadata);
  const cache = cacheTokenFields(result.usage);
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    return { inputTokens, outputTokens, ...cache, accounting: 'provider', estimatedCostUsd };
  }
  return {
    inputTokens: inputBound,
    outputTokens: tokenUpperBound(result.text ?? ''),
    ...cache,
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
 * Per-request cost, where the provider reports one in its metadata. The
 * Vercel AI Gateway's `cost` is what it bills; BYOK routes bill the provider
 * key directly and report `cost: "0"`, so fall back to `marketCost`, the
 * list-price estimate of the same request. OpenRouter reports `usage.cost`
 * when its provider is asked to account usage. Other providers simply lack
 * the key.
 */
export function readCost(
  metadata: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): number | undefined {
  const billed = parseCost(metadata?.['gateway']?.['cost']);
  if (billed !== undefined && billed > 0) return billed;
  const market = parseCost(metadata?.['gateway']?.['marketCost']) ?? billed;
  if (market !== undefined) return market;
  const openrouter = metadata?.['openrouter']?.['usage'];
  return typeof openrouter === 'object' && openrouter !== null ? parseCost((openrouter as Record<string, unknown>)['cost']) : undefined;
}

function parseCost(raw: unknown): number | undefined {
  const cost = typeof raw === 'string' ? Number(raw) : raw;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/**
 * Maps adapter and provider failures onto the closed agent error set. Runs
 * only after `generate` loaded the SDK, so the cached module is available for
 * the error-class checks.
 */
function translateModelError(
  rawCause: unknown,
  issue: string | undefined,
  signal: AbortSignal,
): Error {
  const { APICallError, NoObjectGeneratedError } = aiSdk();
  const cause = unwrapRetry(rawCause);
  if (cause instanceof AgentError) return cause;
  // Only an aborted attempt is a cancellation. A request that exceeded the
  // remaining step budget is a timeout, which is a test failure.
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
  // Too big a request is not a provider outage: the observation budget or
  // the step is what needs to shrink, and the code says so.
  if (isContextOverflow(cause)) {
    return new AgentError(
      'CONTEXT_OVERFLOW',
      `the model request exceeded the context window: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (APICallError.isInstance(cause)) {
    return new AgentError(
      'MODEL_PROVIDER_FAILED',
      withHint(`model provider failed: ${cause.message}`, credentialHint(cause)),
      { cause },
    );
  }
  return new AgentError(
    'MODEL_PROVIDER_FAILED',
    `model provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

/**
 * A rejected credential is named for what it is. The model instance owns its
 * credential, read from the provider package's own variable
 * (`AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, ...) or passed at
 * construction, so the runner can only say that the provider refused it.
 * Requires the SDK to be loaded, which every caller has done by the time a
 * provider call has failed.
 */
export function credentialHint(cause: unknown): string {
  const failure = unwrapRetry(cause);
  if (!(failure instanceof Error)) return '';
  // Gateways raise their own authentication error classes and a raw provider
  // an APICallError; both carry the HTTP status, so that is what is read.
  const statusCode = (failure as { statusCode?: unknown }).statusCode;
  const rejected =
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthenticated|unauthorized|authentication/i.test(`${failure.name} ${failure.message}`);
  if (!rejected) return '';
  return 'the provider rejected the credential the model instance was created with: check the variable the provider package reads, or the key passed at construction';
}

/**
 * Unwraps a spent transport retry chain to the attempt that actually failed,
 * because the wrapper's message names the retry reason rather than the failure.
 * A chain cut short by the deadline stays wrapped so it classifies as an abort.
 */
function unwrapRetry(cause: unknown): unknown {
  const { RetryError } = aiSdk();
  if (!RetryError.isInstance(cause) || cause.reason === 'abort') return cause;
  return cause.lastError ?? cause;
}

/**
 * True when a provider call ended by abort or timeout rather than by a
 * provider answer, including a retry chain the deadline cut short. Requires
 * the SDK to be loaded, which every caller has done by the time a call failed.
 */
export function isAbort(cause: unknown): boolean {
  const { RetryError } = aiSdk();
  if (RetryError.isInstance(cause) && cause.reason === 'abort') return true;
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
}
