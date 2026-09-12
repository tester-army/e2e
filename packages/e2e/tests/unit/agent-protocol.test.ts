import { describe, expect, it } from 'vitest';
import { acceptAnyJson, validateJudgmentResponse } from '../../src/agent/protocol.ts';

describe('agent-judgment-2', () => {
  it('accepts each of the three verdicts with a bounded explanation', () => {
    for (const verdict of ['holds', 'fails', 'inconclusive'] as const) {
      expect(
        validateJudgmentResponse({
          protocolVersion: 'agent-judgment-2',
          verdict,
          explanation: 'the dashboard is not visible',
        }),
      ).toMatchObject({ ok: true, value: { verdict } });
    }
  });

  it('rejects the agent-judgment-1 shape, so a stale boolean never reads as a verdict', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-1',
        result: true,
        explanation: 'yes',
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-2',
        result: true,
        explanation: 'yes',
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects verdicts outside the enum, booleans included', () => {
    for (const verdict of ['probably', 'true', true, false, 1, null]) {
      expect(
        validateJudgmentResponse({ protocolVersion: 'agent-judgment-2', verdict, explanation: '' }),
      ).toMatchObject({ ok: false, issue: 'verdict must be "holds", "fails", or "inconclusive"' });
    }
  });

  it('rejects explanations over 8192 characters', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-2',
        verdict: 'holds',
        explanation: 'x'.repeat(8193),
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects any additional field, including error codes', () => {
    expect(
      validateJudgmentResponse({
        protocolVersion: 'agent-judgment-2',
        verdict: 'fails',
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
