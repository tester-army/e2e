/**
 * Closed `agent-protocol-1` response grammars. Mirrors
 * `schema/agent-judgment-v2.schema.json`; the schema wins on any divergence,
 * and `tests/unit/agent-judgment-schema.test.ts` holds both to the same answers.
 *
 * Validation is runner-owned: a response that does not match exactly is a
 * policy error before any engine dispatch.
 */

import type { JSONSchema7 } from 'ai';

/**
 * The three answers a judgment can give. `holds` and `fails` are product
 * verdicts. `inconclusive` says the observation does not carry enough evidence
 * to decide either way; the runner treats it as a failure, never as a pass,
 * because a judge that guesses when the screen is silent is how a broken flow
 * stays green.
 */
type JudgmentVerdict = 'holds' | 'fails' | 'inconclusive';

const JUDGMENT_VERDICTS: readonly JudgmentVerdict[] = ['holds', 'fails', 'inconclusive'];

interface JudgmentResponse {
  readonly protocolVersion: 'agent-judgment-2';
  readonly verdict: JudgmentVerdict;
  readonly explanation: string;
}

export type ProtocolValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

const EXPLANATION_MAX_LENGTH = 8192;

export const JUDGMENT_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'verdict', 'explanation'],
  properties: {
    protocolVersion: { type: 'string', enum: ['agent-judgment-2'] },
    verdict: { type: 'string', enum: [...JUDGMENT_VERDICTS] },
    explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
  },
};

export function validateJudgmentResponse(value: unknown): ProtocolValidation<JudgmentResponse> {
  const record = asClosedRecord(value, ['protocolVersion', 'verdict', 'explanation']);
  if (record === null) return fail('response is not an agent-judgment-2 object');
  if (record['protocolVersion'] !== 'agent-judgment-2') return fail('unknown protocolVersion');
  const verdict = record['verdict'];
  if (!isJudgmentVerdict(verdict)) return fail('verdict must be "holds", "fails", or "inconclusive"');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  return {
    ok: true,
    value: { protocolVersion: 'agent-judgment-2', verdict, explanation },
  };
}

function isJudgmentVerdict(value: unknown): value is JudgmentVerdict {
  return JUDGMENT_VERDICTS.some((verdict) => verdict === value);
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
  const length = codePointLength(value);
  if (length < min || length > max) return null;
  return value;
}

/**
 * Counts code points, the unit JSON Schema `maxLength` measures. `.length`
 * counts UTF-16 units, so an explanation with astral characters would fail
 * here while the schema accepts it. The string iterator pairs surrogates and
 * counts a lone one as a single code point, as Ajv's `ucs2length` does.
 */
function codePointLength(value: string): number {
  return [...value].length;
}
