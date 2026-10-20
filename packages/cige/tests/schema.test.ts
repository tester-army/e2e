import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { CigeValidationError, parseCige, slugify } from '../src/schema.ts';

function json(relative: string): unknown {
  const value: unknown = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
  return value;
}

const schema = json('../schema/cige-1.schema.json');
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema as object);

describe('cige-1.schema.json', () => {
  it('accepts the valid fixture and the CIGE skills demo case', () => {
    expect(validate(json('../schema/fixtures/cige-1.valid.json')), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(json('./fixtures/checkout-flow.cige.json')), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects the invalid fixture', () => {
    expect(validate(json('../schema/fixtures/cige-1.invalid.json'))).toBe(false);
  });

  it('agrees with parseCige on both fixtures', () => {
    expect(() => parseCige(json('../schema/fixtures/cige-1.valid.json'))).not.toThrow();
    expect(() => parseCige(json('./fixtures/checkout-flow.cige.json'))).not.toThrow();
    expect(() => parseCige(json('../schema/fixtures/cige-1.invalid.json'))).toThrow(CigeValidationError);
  });
});

describe('parseCige', () => {
  it('normalizes the CIGE skills demo case', () => {
    const testCase = parseCige(json('./fixtures/checkout-flow.cige.json'));
    expect(testCase.id).toBe(slugify(testCase.intent.statement));
    expect(testCase.intent).toMatchObject({ success: [], failure: [], evidence: [], judge: true });
    expect(testCase.guardrails.map((rule) => rule.id)).toEqual(['g1', 'g2', 'g3', 'g4']);
    expect(testCase.execution.map((step) => [step.kind, step.id])).toEqual([
      ['act', 'e1'],
      ['act', 'e2'],
      ['act', 'e3'],
      ['act', 'e4'],
      ['act', 'e5'],
    ]);
    expect(testCase.context.specRef).toBe('demo/checkout-flow/specRef.md');
    expect(testCase.context.preconditions.every((entry) => entry.kind === 'fact')).toBe(true);
  });

  it('reads the lowercase field names the paper uses', () => {
    const testCase = parseCige({
      context: { system: 'Todo app' },
      intent: 'A user can add a todo',
      guardrails: ['Do not delete todos'],
      execution: ['add a todo "Buy milk"'],
    });
    expect(testCase.id).toBe('a-user-can-add-a-todo');
    expect(testCase.execution).toEqual([{ kind: 'act', id: 'e1', text: 'add a todo "Buy milk"' }]);
    expect(testCase.guardrails).toEqual([{ id: 'g1', rule: 'Do not delete todos' }]);
  });

  it('refuses a field spelled both ways', () => {
    expect(() => parseCige({ Context: {}, context: {}, Intent: 'x', Execution: ['y'] })).toThrow(/"context" and "Context" are the same field/);
  });

  it('names every problem with its path', () => {
    try {
      parseCige({ Context: {}, Intent: { statement: ' ' }, Execution: [{ id: 'e1', step: 'a' }, { id: 'e1', verify: 'b' }] }, 'bad.cige.json');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CigeValidationError);
      expect((error as CigeValidationError).message).toContain('bad.cige.json');
      expect((error as CigeValidationError).issues.some((issue) => issue.startsWith('Intent'))).toBe(true);
    }
    expect(() => parseCige({ Context: {}, Intent: 'x', Execution: [{ id: 'e1', step: 'a' }, { id: 'e1', verify: 'b' }] })).toThrow(
      /Execution: id "e1" is used twice/,
    );
  });

  it('refuses an Intent that nothing would check', () => {
    expect(() => parseCige({ Context: {}, Intent: { statement: 'Orders persist', judge: false }, Execution: ['place an order'] })).toThrow(
      /would pass on its actions alone/,
    );
    expect(() =>
      parseCige({ Context: {}, Intent: { statement: 'Orders persist', judge: false, evidence: [{ hook: 'orderExists' }] }, Execution: ['place an order'] }),
    ).not.toThrow();
  });

  it('refuses a deny pattern that is not a regular expression', () => {
    expect(() =>
      parseCige({ Context: {}, Intent: 'x', Guardrails: [{ rule: 'no admin', deny: { summary: ['(['] } }], Execution: ['y'] }),
    ).toThrow(/not a valid regular expression/);
  });
});
