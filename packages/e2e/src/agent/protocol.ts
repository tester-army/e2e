/**
 * Closed `agent-protocol-1` response grammars. Mirrors
 * spec/schema/agent-locate-v1.schema.json and agent-judgment-v1.schema.json;
 * the spec files win on any divergence.
 *
 * Validation is runner-owned: a response that does not match exactly is a
 * policy error before any driver dispatch (14-security.md).
 */

import type { JSONSchema7 } from 'ai';

export interface LocateResponse {
  readonly protocolVersion: 'agent-locate-1';
  /** Null is an explicit, valid "nothing in the observation matches". */
  readonly target: { readonly id: string; readonly revision: string } | null;
  /** Why the node was selected, or why no node matches. Untrusted prose. */
  readonly explanation: string;
}

export interface JudgmentResponse {
  readonly protocolVersion: 'agent-judgment-1';
  readonly result: boolean;
  readonly explanation: string;
}

export type ProtocolValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

const REF_MAX_LENGTH = 256;
const EXPLANATION_MAX_LENGTH = 8192;

export const LOCATE_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'target', 'explanation'],
  properties: {
    // Single-value enum rather than const: strict structured-output modes
    // across providers accept enum but not const.
    protocolVersion: { type: 'string', enum: ['agent-locate-1'] },
    target: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'revision'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
            revision: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
          },
        },
        { type: 'null' },
      ],
    },
    explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
  },
};

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

export function validateLocateResponse(value: unknown): ProtocolValidation<LocateResponse> {
  const record = asClosedRecord(value, ['protocolVersion', 'target', 'explanation']);
  if (record === null) return fail('response is not an agent-locate-1 object');
  if (record['protocolVersion'] !== 'agent-locate-1') return fail('unknown protocolVersion');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  if (record['target'] === null) {
    return {
      ok: true,
      value: { protocolVersion: 'agent-locate-1', target: null, explanation },
    };
  }
  const target = asClosedRecord(record['target'], ['id', 'revision']);
  if (target === null) return fail('target is not a node reference or null');
  const id = asBoundedString(target['id'], 1, REF_MAX_LENGTH);
  const revision = asBoundedString(target['revision'], 1, REF_MAX_LENGTH);
  if (id === null || revision === null) return fail('target id/revision are invalid');
  return {
    ok: true,
    value: { protocolVersion: 'agent-locate-1', target: { id, revision }, explanation },
  };
}

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
