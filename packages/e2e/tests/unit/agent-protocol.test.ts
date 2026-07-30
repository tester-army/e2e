import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  acceptAnyJson,
  LOCATE_SCHEMAS,
  validateJudgmentResponse,
  validateLocateResponse,
  type LocateGrammar,
} from '../../src/agent/protocol.ts';

const GRAMMARS = ['node', 'nodeOrPoint', 'point'] as const satisfies readonly LocateGrammar[];

describe('the locate request schema', () => {
  // A field the request schema does not declare is one a strict provider strips
  // from the response, because additionalProperties is false. Asking for
  // `positional` in the prompt alone therefore got it removed from every answer,
  // which left every locate unrecordable and the cache permanently cold. The
  // prompt is not the request; this schema is.
  it('declares and requires every field the validator reads', () => {
    for (const grammar of GRAMMARS) {
      const schema = LOCATE_SCHEMAS[grammar];
      expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual([
        'explanation',
        'positional',
        'protocolVersion',
        'target',
      ]);
      // Strict structured-output modes emit only required properties, so an
      // optional field here is an absent field in practice.
      expect(schema.required?.toSorted()).toEqual([
        'explanation',
        'positional',
        'protocolVersion',
        'target',
      ]);
    }
  });

  it('accepts what the validator accepts, so a compliant answer round-trips', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    // The request schema is typed as the SDK's JSONSchema7; ajv types its own
    // input, and the two describe the same JSON.
    const requestSchema = LOCATE_SCHEMAS.node as object;
    const answer = {
      protocolVersion: 'agent-locate-1',
      target: { id: 'n7', revision: 'r3' },
      explanation: 'the only email input',
      positional: false,
    };
    expect(ajv.validate(requestSchema, answer)).toBe(true);
    expect(validateLocateResponse(answer)).toMatchObject({
      ok: true,
      value: { targeting: 'content' },
    });
  });
});

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
        targeting: 'unreported',
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
        targeting: 'unreported',
      },
    });
  });

  it('distinguishes a reported positional hint from an absent one', () => {
    const base = {
      protocolVersion: 'agent-locate-1',
      target: { id: 'n7', revision: 'r3' },
      explanation: 'the first row',
    };
    expect(validateLocateResponse({ ...base, positional: true })).toMatchObject({
      ok: true,
      value: { targeting: 'position' },
    });
    expect(validateLocateResponse({ ...base, positional: false })).toMatchObject({
      ok: true,
      value: { targeting: 'content' },
    });
    // A model that predates the hint still produces a valid response, but its
    // silence must never be read as the recordable answer.
    expect(validateLocateResponse(base)).toMatchObject({
      ok: true,
      value: { targeting: 'unreported' },
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

  describe('point targets', () => {
    const pointResponse = {
      protocolVersion: 'agent-locate-1',
      target: { point: { x: 412, y: 268 }, revision: 'r3' },
      explanation: 'the red pin is drawn there',
    };

    it('accepts a point only when the call offered one', () => {
      expect(validateLocateResponse(pointResponse, 'nodeOrPoint')).toEqual({
        ok: true,
        value: { ...pointResponse, targeting: 'unreported' },
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
        value: { ...pointResponse, targeting: 'unreported' },
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
