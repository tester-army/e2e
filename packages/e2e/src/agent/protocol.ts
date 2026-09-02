/**
 * Closed `agent-protocol-1` response grammars. Mirrors
 * spec/schema/agent-judgment-v1.schema.json; the spec file wins on any
 * divergence.
 *
 * Validation is runner-owned: a response that does not match exactly is a
 * policy error before any backend dispatch (14-security.md).
 */

import type { JSONSchema7 } from 'ai';

export interface JudgmentResponse {
  readonly protocolVersion: 'agent-judgment-1';
  readonly result: boolean;
  readonly explanation: string;
}

export type ProtocolValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

const EXPLANATION_MAX_LENGTH = 8192;

export const JUDGMENT_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'result', 'explanation'],
  properties: {
    protocolVersion: { type: 'string', enum: ['agent-judgment-1'] },
    result: { type: 'boolean' },
    explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
  },
};

export function validateJudgmentResponse(value: unknown): ProtocolValidation<JudgmentResponse> {
  const record = asClosedRecord(value, ['protocolVersion', 'result', 'explanation']);
  if (record === null) return fail('response is not an agent-judgment-1 object');
  if (record['protocolVersion'] !== 'agent-judgment-1') return fail('unknown protocolVersion');
  if (typeof record['result'] !== 'boolean') return fail('result must be a boolean');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  return {
    ok: true,
    value: { protocolVersion: 'agent-judgment-1', result: record['result'], explanation },
  };
}

/**
 * `agent.extract` sends no provider schema, because only the caller's Standard
 * Schema knows the payload shape. Any parsed JSON value is therefore protocol
 * valid; the caller's schema is the only authority over its contents.
 */
export function acceptAnyJson(value: unknown): ProtocolValidation<unknown> {
  return { ok: true, value };
}

function fail(issue: string): { ok: false; issue: string } {
  return { ok: false, issue };
}

/** Accepts a plain object whose keys are exactly within the allowed set. */
function asClosedRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return null;
  }
  return value as Record<string, unknown>;
}

function asBoundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < min || value.length > max) return null;
  return value;
}
