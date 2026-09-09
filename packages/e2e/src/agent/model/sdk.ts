/**
 * AI SDK adapter. One implementation serves every
 * provider: a `provider/model-id` reference resolves through the AI Gateway,
 * and a caller-supplied AI SDK model instance (`openai('gpt-4o')`, a local
 * provider, a scripted test model) is used directly. Everything after model
 * construction — bounded requests, closed-grammar validation, usage and error
 * translation — is provider-independent.
 */

import type { ModelMessage } from 'ai';
import { withHint } from '../../internal/errors.ts';
import { GATEWAY_API_KEY_ENV, type ResolvedModel, type SdkLanguageModel } from '../../config/agent.ts';
import { aiSdk, loadAiSdk } from '../ai-sdk.ts';
import { packageVersion } from '../../internal/package-version.ts';
import { AgentError } from '../error.ts';
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

/** Default AI Gateway base URL used when no endpoint override is configured. */
const DEFAULT_GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v4/ai';

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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
      'the agent fixture requires a model: pass one to createAgent({ model }), set agent.model, or set E2E_MODEL',
    );
  }
  const { endpoint, flavor } = validateModel(model);
  const adapterVersion = packageVersion(import.meta.url, '../../../package.json', '0.0.0');
  // The AI SDK is an optional peer: the language model is constructed on the
  // first call, after the loader has resolved (or clearly refused) it.
  let languageModel: SdkLanguageModel | undefined;

  return {
    provenance: {
      provider: model.provider,
      model: model.id,
      endpoint,
      adapterVersion: `${flavor}/${adapterVersion}`,
    },
    async generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>> {
      const { generateText, jsonSchema, Output } = await loadAiSdk();
      languageModel ??= instantiate(model).languageModel;
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
      const settings = {
        model: languageModel,
        system: call.system,
        // Text-only calls keep the plain prompt form; images require the
        // multi-part message form, and both must carry the same instruction
        // text in the same position relative to the system policy.
        ...(images.length === 0
          ? { prompt: call.prompt }
          : { messages: [userMessage(call.prompt, images)] }),
        maxOutputTokens: call.maxOutputTokens,
        ...(call.providerOptions === undefined
          ? {}
          : { providerOptions: call.providerOptions as never }),
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
        throw translateModelError(cause, issue, call.signal, model);
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
 * Builds the bare AI SDK language model for one resolved model reference, for
 * callers that drive the SDK directly (the default step executor) rather than
 * through the adapter. Fails with MODEL_UNAVAILABLE exactly like the adapter.
 * Gateway references require the AI SDK to be loaded (loadAiSdk) first; model
 * instances never touch it.
 */
export function instantiateLanguageModel(model: ResolvedModel): SdkLanguageModel {
  return instantiate(model).languageModel;
}

/**
 * Validates one resolved model and derives its report provenance without
 * touching the AI SDK, so an adapter can be constructed — and refuse clearly —
 * before the optional peer dependency is ever loaded.
 */
function validateModel(model: ResolvedModel): { endpoint: string; flavor: string } {
  if (model.kind === 'instance') {
    // The instance owns its transport; the report records that the endpoint is
    // whatever the provider package defaults to.
    return { endpoint: 'provider-default', flavor: 'ai-sdk' };
  }
  if (!PROVIDER_PATTERN.test(model.provider)) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      `unknown model provider "${model.provider}"; expected a gateway provider ID or an AI SDK model instance`,
    );
  }
  if (model.apiKey === undefined) {
    throw new AgentError(
      'MODEL_UNAVAILABLE',
      `no model credential: set ${model.apiKeyEnv} or ${GATEWAY_API_KEY_ENV}`,
    );
  }
  return { endpoint: model.endpoint ?? DEFAULT_GATEWAY_ENDPOINT, flavor: 'ai-gateway' };
}

/**
 * The variable each gateway language model's credential was read from, keyed
 * by the model object the SDK is handed. The tool loop sees only that object,
 * and this is how a rejected credential is still reported by its source. A
 * name, never a value.
 */
const credentialSources = new WeakMap<object, string>();

/** Builds the AI SDK language model for one validated resolved model. */
function instantiate(model: ResolvedModel): { languageModel: SdkLanguageModel } {
  if (model.kind === 'instance') return { languageModel: model.model };
  const { endpoint } = validateModel(model);
  const gateway = aiSdk().createGateway({ apiKey: model.apiKey as string, baseURL: endpoint });
  const languageModel = gateway.languageModel(`${model.provider}/${model.id}`);
  credentialSources.set(languageModel, model.apiKeySource ?? model.apiKeyEnv);
  return { languageModel };
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
 * The AI Gateway reports per-request cost in provider metadata when available;
 * other providers simply lack the key. `cost` is what the gateway bills; BYOK
 * routes bill the provider key directly and report `cost: "0"`, so fall back
 * to `marketCost`, the list-price estimate of the same request.
 */
export function readCost(
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

/**
 * Maps adapter and provider failures onto the closed agent error set. Runs
 * only after `generate` loaded the SDK, so the cached module is available for
 * the error-class checks.
 */
function translateModelError(
  rawCause: unknown,
  issue: string | undefined,
  signal: AbortSignal,
  model: ResolvedModel,
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
  if (APICallError.isInstance(cause)) {
    return new AgentError(
      'MODEL_PROVIDER_FAILED',
      withHint(`model provider failed: ${cause.message}`, credentialHint(cause, model)),
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
 * A rejected credential names the variable the runner read it from, whether
 * that was `E2E_MODEL_API_KEY`, the gateway's own `AI_GATEWAY_API_KEY`, or
 * the one `apiKeyEnv` chose. The gateway's own text only ever says
 * `AI_GATEWAY_API_KEY`. Takes the resolved model (the adapter path) or the SDK
 * model object (the tool loop path); a model that brought its own credential
 * has no variable to name. Requires the SDK to be loaded, which every caller
 * has done by the time a provider call has failed.
 */
export function credentialHint(cause: unknown, model?: ResolvedModel | SdkLanguageModel | string): string {
  const failure = unwrapRetry(cause);
  if (!(failure instanceof Error)) return '';
  // The gateway raises its own authentication error class and a raw provider
  // an APICallError; both carry the HTTP status, so that is what is read.
  const statusCode = (failure as { statusCode?: unknown }).statusCode;
  const rejected =
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthenticated|unauthorized|authentication/i.test(`${failure.name} ${failure.message}`);
  if (!rejected) return '';
  const source = credentialSource(model);
  if (source === undefined) return 'the provider rejected the credential the model instance was created with';
  return `the gateway rejected the credential read from ${source}: check that the key is complete and belongs to the AI Gateway (https://vercel.com/docs/ai-gateway)`;
}

/** The variable a gateway model's credential came from; undefined for a model that owns its own. */
function credentialSource(model: ResolvedModel | SdkLanguageModel | string | undefined): string | undefined {
  if (model === undefined || typeof model !== 'object') return undefined;
  if ('kind' in model) return model.kind === 'gateway' ? (model.apiKeySource ?? model.apiKeyEnv) : undefined;
  return credentialSources.get(model);
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
