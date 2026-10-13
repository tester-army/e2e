import { describe, expect, it } from 'vitest';

import { redactParams, validateActOptions, validateParams, validateVerdict } from '../../src/agent/act-validation.ts';
import { templateParams } from '../../src/cache/template.ts';
import { bound } from '../../src/internal/text.ts';
import { unique } from '../../src/params.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';

describe('validateActOptions', () => {
  it('accepts the options bag and an absent one', () => {
    expect(() => validateActOptions(undefined, 0)).not.toThrow();
    expect(() =>
      validateActOptions({ params: { plan: 'pro' }, timeout: 1_000, maxSteps: 3, maxModelCalls: 4 }, 0),
    ).not.toThrow();
  });

  it('names the move for the pre-0.8 act(instruction, params) call', () => {
    expect(() => validateActOptions({ name: 'Ada', email: 'ada@example.test' } as never, 0)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message:
          'agent.act options has no keys "name", "email"; the values an instruction refers to go under params: act(instruction, { params: { name, email } })',
      }),
    );
  });

  it('names schema and vision as capabilities act does not have', () => {
    expect(() => validateActOptions({ schema: {} } as never, 0)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/options\.schema/) }),
    );
    expect(() => validateActOptions({ vision: false } as never, 0)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/takes no vision option/) }),
    );
    expect(() => validateActOptions({ vision: true } as never, 0)).toThrow(ConfigurationError);
  });
});

describe('redactParams', () => {
  const SECRET = 'sk_param_4Rt9Zq';
  const redact = (text: string) => text.replaceAll(SECRET, '<secret:probe>');

  it('redacts keys and leaves and moves unique() templates with their leaves, so the cache key slots them', () => {
    const { projected, templates } = validateParams({
      note: SECRET,
      [`account ${SECRET}`]: { name: unique(`E2E ${SECRET} 42`), tags: [SECRET, 7] },
    });
    expect(templates).toEqual([{ pointer: `/account ${SECRET}/name`, value: `E2E ${SECRET} 42` }]);
    const redacted = redactParams(projected!, templates, redact);
    expect(redacted.params).toEqual({
      note: '<secret:probe>',
      'account <secret:probe>': { name: 'E2E <secret:probe> 42', tags: ['<secret:probe>', 7] },
    });
    expect(redacted.templates).toEqual([{ pointer: '/account <secret:probe>/name', value: 'E2E <secret:probe> 42' }]);
    expect(templateParams(redacted.params, redacted.templates)).toEqual({
      note: '<secret:probe>',
      'account <secret:probe>': { name: '{{param:/account <secret:probe>/name}}', tags: ['<secret:probe>', 7] },
    });
  });

  it('keeps a __proto__ key as an own property', () => {
    const { projected, templates } = validateParams(JSON.parse(`{"__proto__":"${SECRET}","note":"x"}`) as Record<string, string>);
    const redacted = redactParams(projected!, templates, redact);
    expect(Object.hasOwn(redacted.params, '__proto__')).toBe(true);
    expect(JSON.stringify(redacted.params)).toBe('{"__proto__":"<secret:probe>","note":"x"}');
  });

  it('refuses two keys that redact alike instead of dropping one', () => {
    const { projected, templates } = validateParams({ nested: { [`id ${SECRET}`]: 1, 'id <secret:probe>': 2 } });
    expect(() => redactParams(projected!, templates, redact)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: 'agent.act params has two keys that read "id <secret:probe>" once secret values are redacted; a key cannot be told apart by a secret',
      }),
    );
  });
});

describe('verdict summary bounds', () => {
  it('keeps ordinary trimmed summaries and the verdict shape with the default redactor', () => {
    expect(validateVerdict({ status: 'passed', summary: '  step passed  ' }, 'executor')).toEqual({ status: 'passed', summary: 'step passed' });
    expect(validateVerdict({ status: 'failed', summary: 'failed', errorCode: 'ASSERTION_FAILED' }, 'executor')).toEqual({ status: 'failed', summary: 'failed', errorCode: 'ASSERTION_FAILED' });
  });

  it('redacts known values before the producer cap can leave a fragment', () => {
    const plaintext = 'PQ7rs9Uv4wx2';
    const result = validateVerdict({ status: 'passed', summary: 'x'.repeat(1997) + plaintext }, 'executor', (text) => text.replaceAll(plaintext, '<secret:summary>'));
    expect(result.summary).toHaveLength(2000);
    expect(result.summary.endsWith('…')).toBe(true);
    const expected = 'x'.repeat(1997) + '<s…';
    expect(result.summary).toBe(expected);
    for (const prefix of ['P', 'PQ', 'PQ7']) expect(result.summary).not.toContain(prefix);
    // This deliberate bad transform would pass the former !PQ7 oracle.
    const capFirst = bound('x'.repeat(1997) + plaintext, 2000).replaceAll(plaintext, '<secret:summary>');
    expect(capFirst).toBe('x'.repeat(1997) + 'PQ…');
    expect(capFirst).not.toBe(expected);
  });

  it('explicitly marks producer cuts, including unknown secret prefixes and surrogate boundaries', () => {
    const summary = validateVerdict({ status: 'passed', summary: 'x'.repeat(1997) + 'PQ7rs9Uv4wx2' }, 'executor').summary;
    expect(summary).toHaveLength(2000);
    expect(summary.endsWith('PQ…')).toBe(true);
    const unicode = validateVerdict({ status: 'passed', summary: 'x'.repeat(1998) + '😀z' }, 'executor').summary;
    expect(unicode).toBe('x'.repeat(1998) + '…');
    expect(validateVerdict({ status: 'passed', summary: 'x'.repeat(2000) }, 'executor').summary).toHaveLength(2000);
  });
});
