import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveJsonSchema } from '../../src/agent/model/schema.ts';
import { extractSchema, validateExtractResponse, validateJudgmentResponse } from '../../src/agent/protocol.ts';

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

describe('agent-extract-2', () => {
  it('passes any found value through: the caller schema is the only authority over it', () => {
    for (const value of [{ total: 42 }, [1, 2], null, 'done']) {
      expect(validateExtractResponse({ found: true, value, missing: null })).toEqual({ ok: true, value: { found: true, value } });
    }
  });

  it('reads a not-found answer and what was missing', () => {
    expect(validateExtractResponse({ found: false, value: null, missing: 'no phone number' })).toEqual({
      ok: true, value: { found: false, missing: 'no phone number' },
    });
    expect(validateExtractResponse({ found: false, value: null, missing: ' ' })).toEqual({ ok: true, value: { found: false, missing: undefined } });
  });

  it('rejects a bare value, a non-boolean found, and undeclared fields', () => {
    expect(validateExtractResponse({ total: 42 })).toMatchObject({ ok: false });
    expect(validateExtractResponse({ found: 'yes', value: 1, missing: null })).toMatchObject({ ok: false });
    expect(validateExtractResponse({ found: true, value: 1, missing: null, note: 'x' })).toMatchObject({ ok: false });
    expect(validateExtractResponse({ found: false, value: null, missing: 3 })).toMatchObject({ ok: false });
  });

  it('moves a recursive root into the envelope definitions, so its self refs do not name the envelope', async () => {
    const Category: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string().min(1),
      get children() { return z.array(Category); },
    });
    const envelope = extractSchema((await deriveJsonSchema(Category))!);
    expect(envelope.properties?.['value']).toMatchObject({ anyOf: [{ $ref: '#/definitions/extractValue' }, { type: 'null' }] });
    expect(envelope.definitions?.['extractValue']).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'children'],
      properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/definitions/extractValue' } } },
    });
    expect(JSON.stringify(envelope)).not.toContain('"$ref":"#"');
  });

  it('names the moved root so it clashes with no definition the caller already has', () => {
    const shape = {
      type: 'object',
      properties: { label: { $ref: '#/definitions/extractValue' }, children: { type: 'array', items: { $ref: '#' } } },
      definitions: { extractValue: { type: 'string' } },
    } as const;
    const envelope = extractSchema(shape);
    expect(envelope.definitions?.['extractValue']).toEqual({ type: 'string' });
    expect(envelope.properties?.['value']).toMatchObject({ anyOf: [{ $ref: '#/definitions/extractValue2' }, { type: 'null' }] });
    expect(envelope.definitions?.['extractValue2']).toEqual({
      type: 'object',
      properties: { label: { $ref: '#/definitions/extractValue' }, children: { type: 'array', items: { $ref: '#/definitions/extractValue2' } } },
    });
  });

  it('projects the caller schema as a shape and hoists its definitions to the envelope root', async () => {
    const Node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string().min(1),
      get children() { return z.array(Node).max(3); },
    });
    const shape = await deriveJsonSchema(z.object({
      tree: Node,
      email: z.string().email().regex(/@/),
      size: z.enum(['S', 'M']),
      tags: z.array(z.string()).min(2),
    }));
    const envelope = extractSchema(shape!);
    expect(envelope).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['found', 'value', 'missing'],
      properties: {
        found: expect.objectContaining({ type: 'boolean' }),
        value: expect.objectContaining({
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['tree', 'email', 'size', 'tags'],
              properties: {
                tree: { $ref: '#/definitions/__schema0' },
                email: { type: 'string' },
                size: { type: 'string', enum: ['S', 'M'] },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
            { type: 'null' },
          ],
        }),
        missing: expect.objectContaining({ type: ['string', 'null'] }),
      },
      definitions: {
        __schema0: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'children'],
          properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/definitions/__schema0' } } },
        },
      },
    });
  });
});
