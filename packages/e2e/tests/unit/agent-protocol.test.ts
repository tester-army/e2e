import { describe, expect, it } from 'vitest';
import {
  acceptAnyJson,
  validateJudgmentResponse,
  validateLocateResponse,
} from '../../src/agent/protocol.ts';

describe('agent-locate-1', () => {
  it('accepts exactly the closed shape', () => {
    const result = validateLocateResponse({
      protocolVersion: 'agent-locate-1',
      target: { id: 'n7', revision: 'r3' },
      explanation: 'the only email input',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        protocolVersion: 'agent-locate-1',
        target: { id: 'n7', revision: 'r3' },
        explanation: 'the only email input',
        positional: false,
      },
    });
  });

  it('accepts an explicit no-match with a null target', () => {
    const result = validateLocateResponse({
      protocolVersion: 'agent-locate-1',
      target: null,
      explanation: 'the observation shows a login page without a search box',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        protocolVersion: 'agent-locate-1',
        target: null,
        explanation: 'the observation shows a login page without a search box',
        positional: false,
      },
    });
  });

  it('reads the optional positional hint and defaults it to false', () => {
    const base = {
      protocolVersion: 'agent-locate-1',
      target: { id: 'n7', revision: 'r3' },
      explanation: 'the first row',
    };
    expect(validateLocateResponse({ ...base, positional: true })).toMatchObject({
      ok: true,
      value: { positional: true },
    });
    expect(validateLocateResponse({ ...base, positional: false })).toMatchObject({
      ok: true,
      value: { positional: false },
    });
    // A model that predates the hint still produces a valid response.
    expect(validateLocateResponse(base)).toMatchObject({
      ok: true,
      value: { positional: false },
    });
  });

  it('rejects a non-boolean positional hint', () => {
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: { id: 'n7', revision: 'r3' },
        explanation: 'the first row',
        positional: 'yes',
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects a response without an explanation', () => {
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: { id: 'n7', revision: 'r3' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateLocateResponse({ protocolVersion: 'agent-locate-1', target: null }),
    ).toMatchObject({ ok: false });
  });

  it('rejects explanations over 8192 characters', () => {
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: null,
        explanation: 'x'.repeat(8193),
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects unknown protocol versions', () => {
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-2',
        target: { id: 'a', revision: 'b' },
        explanation: '',
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects unknown fields anywhere in the response', () => {
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: { id: 'a', revision: 'b' },
        explanation: '',
        action: 'tap',
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: { id: 'a', revision: 'b', selector: '#a' },
        explanation: '',
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects missing, empty, and oversized references', () => {
    expect(validateLocateResponse({ protocolVersion: 'agent-locate-1' })).toMatchObject({
      ok: false,
    });
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: { id: '', revision: 'r1' },
        explanation: '',
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateLocateResponse({
        protocolVersion: 'agent-locate-1',
        target: { id: 'x'.repeat(257), revision: 'r1' },
        explanation: '',
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects non-object and array responses', () => {
    expect(validateLocateResponse(null)).toMatchObject({ ok: false });
    expect(validateLocateResponse([])).toMatchObject({ ok: false });
    expect(validateLocateResponse('agent-locate-1')).toMatchObject({ ok: false });
  });
});

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
