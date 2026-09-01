import { describe, expect, it } from 'vitest';
import { acceptAnyJson, validateJudgmentResponse } from '../../src/agent/protocol.ts';

describe('agent-judgment-1', () => {
  it('accepts a boolean result with a bounded explanation', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-1',
        result: false,
        explanation: 'the dashboard is not visible',
      }),
    ).toMatchObject({ ok: true, value: { result: false } });
  });

  it('rejects non-boolean results and truthy strings', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-1',
        result: 'true',
        explanation: '',
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects explanations over 8192 characters', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-1',
        result: true,
        explanation: 'x'.repeat(8193),
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects any additional field, including error codes', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-1',
        result: false,
        explanation: 'no',
        code: 'ASSERTION_FAILED',
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('extract payloads', () => {
  it('treats any parsed JSON value as protocol valid', () => {
    // The caller's Standard Schema is the only authority over extracted data.
    expect(acceptAnyJson({ total: 42 })).toEqual({ ok: true, value: { total: 42 } });
    expect(acceptAnyJson([1, 2])).toEqual({ ok: true, value: [1, 2] });
    expect(acceptAnyJson(null)).toEqual({ ok: true, value: null });
    expect(acceptAnyJson('done')).toEqual({ ok: true, value: 'done' });
  });
});
