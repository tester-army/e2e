import { describe, expect, it } from 'vitest';

import { redactParams, validateActOptions, validateParams } from '../../src/agent/act-validation.ts';
import { templateParams } from '../../src/cache/template.ts';
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
