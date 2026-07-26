/** Model adapter contract (spec 05-config.md, 10-determinism.md, 14-security.md). */

import type { JSONSchema7 } from 'ai';
import { AgentError } from '../error.ts';
import type { ProtocolValidation } from '../protocol.ts';

/** Token accounting for one model call. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly accounting: 'provider' | 'adapter-upper-bound';
  readonly estimatedCostUsd: number | undefined;
}

/** Provenance recorded for every model-backed step (13-reporting.md). */
export interface ModelProvenance {
  readonly provider: string;
  readonly model: string;
  /** `local` for in-process adapters, otherwise an absolute endpoint URI. */
  readonly endpoint: string;
  readonly adapterVersion: string;
}

/** One bounded, stateless model request. There is no shared transcript. */
export interface ModelCall<Value> {
  /** Trusted runner policy followed by trusted project context. */
  readonly system: string;
  /** Untrusted evidence and the method instruction. */
  readonly prompt: string;
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
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface ModelResult<Value> {
  readonly value: Value;
  readonly usage: ModelUsage;
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
    this.name = 'AgentError';
    this.rawText = options.rawText;
  }
}

/**
 * Conservative token upper bound. UTF-8 byte length bounds every byte-level
 * tokenizer from above, so it is used when a provider reports no usage and for
 * the pre-flight ceiling required by 14-security.md.
 */
export function tokenUpperBound(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
