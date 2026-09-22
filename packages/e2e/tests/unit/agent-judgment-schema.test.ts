/**
 * `validateJudgmentResponse` and `schema/agent-judgment-v2.schema.json` give
 * the same answer for every input. The schema wins on divergence, so a case
 * that fails here is a runtime bug. The provider-facing `JUDGMENT_SCHEMA`,
 * the copy the model is asked to fill, is held to the same answers.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type SchemaObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { JUDGMENT_SCHEMA, validateJudgmentResponse } from '../../src/agent/protocol.ts';

const SCHEMA_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema');

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(path.join(SCHEMA_ROOT, ...segments), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const wireSchema = ajv.compile(readJson('agent-judgment-v2.schema.json') as Record<string, unknown>);
const providerSchema = ajv.compile(JUDGMENT_SCHEMA as SchemaObject);

function judgment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'agent-judgment-2',
    verdict: 'holds',
    explanation: 'the dashboard is visible',
    ...overrides,
  };
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

const ASTRAL = '\u{1F600}';
const LONE_SURROGATE = '\uD83D';

const cases: readonly { readonly name: string; readonly value: unknown; readonly accepted: boolean }[] = [
  { name: 'the valid fixture', value: readJson('fixtures', 'agent-judgment-v2.valid.json'), accepted: true },
  { name: 'the invalid fixture', value: readJson('fixtures', 'agent-judgment-v2.invalid.json'), accepted: false },
  { name: 'a fails verdict', value: judgment({ verdict: 'fails' }), accepted: true },
  { name: 'an inconclusive verdict', value: judgment({ verdict: 'inconclusive' }), accepted: true },
  { name: 'an empty explanation', value: judgment({ explanation: '' }), accepted: true },
  { name: 'an explanation of 8192 characters', value: judgment({ explanation: 'x'.repeat(8192) }), accepted: true },
  { name: 'an explanation of 8192 astral code points', value: judgment({ explanation: ASTRAL.repeat(8192) }), accepted: true },
  { name: 'an explanation of 8193 characters', value: judgment({ explanation: 'x'.repeat(8193) }), accepted: false },
  { name: 'an explanation of 8193 astral code points', value: judgment({ explanation: ASTRAL.repeat(8193) }), accepted: false },
  { name: 'an explanation of 8192 lone surrogates', value: judgment({ explanation: LONE_SURROGATE.repeat(8192) }), accepted: true },
  { name: 'an explanation of 8193 lone surrogates', value: judgment({ explanation: LONE_SURROGATE.repeat(8193) }), accepted: false },
  { name: 'an extra key', value: judgment({ confidence: 0.9 }), accepted: false },
  { name: 'a verdict outside the enum', value: judgment({ verdict: 'true' }), accepted: false },
  { name: 'a boolean verdict', value: judgment({ verdict: true }), accepted: false },
  { name: 'a null verdict', value: judgment({ verdict: null }), accepted: false },
  { name: 'a missing verdict', value: without(judgment(), 'verdict'), accepted: false },
  { name: 'a missing explanation', value: without(judgment(), 'explanation'), accepted: false },
  { name: 'a missing protocolVersion', value: without(judgment(), 'protocolVersion'), accepted: false },
  { name: 'a non-string explanation', value: judgment({ explanation: 42 }), accepted: false },
  { name: 'the agent-judgment-1 shape', value: { protocolVersion: 'agent-judgment-1', result: true, explanation: 'yes' }, accepted: false },
  { name: 'null', value: null, accepted: false },
  { name: 'an array', value: [judgment()], accepted: false },
  { name: 'a JSON string', value: JSON.stringify(judgment()), accepted: false },
];

describe('agent-judgment-2', () => {
  it.each(cases)('$name: the wire schema, the provider schema, and the runtime agree', ({ value, accepted }) => {
    expect(wireSchema(value), 'wire schema').toBe(accepted);
    expect(providerSchema(value), 'provider schema').toBe(accepted);
    expect(validateJudgmentResponse(value).ok, 'runtime').toBe(accepted);
  });
});
