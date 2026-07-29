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
      },
    });
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

  describe('point targets', () => {
    const pointResponse = {
      protocolVersion: 'agent-locate-1',
      target: { point: { x: 412, y: 268 }, revision: 'r3' },
      explanation: 'the red pin is drawn there',
    };

    it('accepts a point only when the call offered one', () => {
      expect(validateLocateResponse(pointResponse, 'nodeOrPoint')).toEqual({
        ok: true,
        value: pointResponse,
      });
    });

    it('rejects a point answered to a tree-only call', () => {
      expect(validateLocateResponse(pointResponse)).toMatchObject({ ok: false });
      expect(validateLocateResponse(pointResponse, 'node')).toMatchObject({ ok: false });
    });

    it('requires the observation revision the point answers for', () => {
      expect(
        validateLocateResponse(
          {
            protocolVersion: 'agent-locate-1',
            target: { point: { x: 1, y: 2 } },
            explanation: '',
          },
          'nodeOrPoint',
        ),
      ).toMatchObject({ ok: false });
    });

    it('rejects malformed, negative, and non-finite coordinates', () => {
      const bad = [
        { x: 1 },
        { x: 1, y: 2, z: 3 },
        { x: -1, y: 2 },
        { x: 1, y: Number.NaN },
        { x: 1, y: Number.POSITIVE_INFINITY },
        { x: '1', y: '2' },
        { x: 100_001, y: 0 },
      ];
      for (const point of bad) {
        expect(
          validateLocateResponse(
            {
              protocolVersion: 'agent-locate-1',
              target: { point, revision: 'r3' },
              explanation: '',
            },
            'nodeOrPoint',
          ),
        ).toMatchObject({ ok: false });
      }
    });

    it('rejects a node id when no observation was attached', () => {
      // The point-only grammar means the model was shown no tree, so any
      // identifier it names is invented — including one that happens to exist.
      const node = {
        protocolVersion: 'agent-locate-1',
        target: { id: 'n1', revision: 'r3' },
        explanation: '',
      };
      expect(validateLocateResponse(node, 'point')).toMatchObject({ ok: false });
      expect(validateLocateResponse(pointResponse, 'point')).toEqual({
        ok: true,
        value: pointResponse,
      });
    });

    it('still rejects a target carrying both a node id and a point', () => {
      expect(
        validateLocateResponse(
          {
            protocolVersion: 'agent-locate-1',
            target: { id: 'n1', point: { x: 1, y: 2 }, revision: 'r3' },
            explanation: '',
          },
          'nodeOrPoint',
        ),
      ).toMatchObject({ ok: false });
    });
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
