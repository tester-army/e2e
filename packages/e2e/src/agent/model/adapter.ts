/** Model adapter contract. */

import type { JSONSchema7 } from 'ai';
import type { ProviderOptions } from '../../types.ts';
import { AgentError } from '../error.ts';
import type { ProtocolValidation } from '../protocol.ts';

/** Token accounting for one model call. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Prompt-cache split of `inputTokens`, when the provider reports one. */
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly accounting: 'provider' | 'adapter-upper-bound';
  readonly estimatedCostUsd: number | undefined;
}

/** Provenance recorded for every model-backed step. */
export interface ModelProvenance {
  readonly provider: string;
  readonly model: string;
  /**
   * `local` for in-process adapters, `provider-default` when a caller-supplied
   * model instance owns its own transport, otherwise an absolute endpoint URI.
   */
  readonly endpoint: string;
  readonly adapterVersion: string;
}

/** Untrusted pixel evidence sent alongside the prompt. */
export interface ModelImage {
  readonly data: Uint8Array;
  readonly mediaType: string;
  /** CSS pixel geometry, used for the pre-flight token bound. */
  readonly width: number;
  readonly height: number;
}

/** One bounded, stateless model request. There is no shared transcript. */
export interface ModelCall<Value> {
  /** Trusted runner policy followed by trusted project context. */
  readonly system: string;
  /** Untrusted evidence and the method instruction. */
  readonly prompt: string;
  /**
   * Untrusted image evidence attached to the same user message. Present only
   * for vision calls; a non-multimodal provider rejects the request.
   */
  readonly images?: readonly ModelImage[] | undefined;
  readonly schemaName: string;
  /**
   * Closed response grammar sent to the provider as a structured-output
   * schema. Omitted when only the runner can validate the payload, in which
   * case the adapter parses one JSON object from the response text.
   */
  readonly schema: JSONSchema7 | undefined;
  readonly validate: (value: unknown) => ProtocolValidation<Value>;
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
  /** Provider options from `agent.providerOptions`, passed through as-is. */
  readonly providerOptions?: ProviderOptions | undefined;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface ModelResult<Value> {
  readonly value: Value;
  readonly usage: ModelUsage;
  /** The model's reasoning text for the call, when it produced one. */
  readonly reasoning: string | undefined;
}

export interface ModelAdapter {
  readonly provenance: ModelProvenance;
  /** Performs exactly one model request and validates its response. */
  generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>>;
}

/**
 * Raised when a provider response cannot be parsed or fails the closed
 * grammar. The raw text is carried so the caller may spend remaining budget on
 * one repair attempt.
 */
export class ModelOutputInvalidError extends AgentError {
  readonly rawText: string | undefined;

  constructor(issue: string, options: { rawText?: string; cause?: unknown } = {}) {
    super('MODEL_OUTPUT_INVALID', issue, options.cause === undefined ? {} : { cause: options.cause });
    this.rawText = options.rawText;
  }
}

/**
 * Conservative token upper bound. UTF-8 byte length bounds every byte-level
 * tokenizer from above, so it is used when a provider reports no usage and for
 * the pre-flight ceiling: unavailable accounting fails before the request.
 *
 * Every budget that mixes with this one — reserves, ledger size, observation
 * size — is therefore in the same byte-scaled units, not in real tokens.
 */
export function tokenUpperBound(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Side of the square patch tile-based vision encoders consume an image in. */
const IMAGE_TILE_PX = 28;

/**
 * Conservative token bound for one image. Vision providers bill images by
 * fixed-size patches rather than bytes, so the count of patches covering the
 * image bounds every such encoder from above closely enough to keep a vision
 * call inside `limits.maxModelTokensPerCall`. Compressed byte length would be
 * meaningless here: a blank screenshot is small and a photograph is not, while
 * both cost the same number of patches.
 */
export function imageTokenUpperBound(image: { width: number; height: number }): number {
  return (
    Math.ceil(Math.max(1, image.width) / IMAGE_TILE_PX) *
    Math.ceil(Math.max(1, image.height) / IMAGE_TILE_PX)
  );
}
