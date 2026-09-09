import { describe, expect, it } from 'vitest';

import { validateActOptions } from '../../src/agent/act-validation.ts';
import { ConfigurationError, TestError } from '../../src/internal/errors.ts';

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

  it('rejects the pre-0.8 third argument', () => {
    expect(() => validateActOptions({ params: {} }, 1)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/takes two arguments/) }),
    );
  });

  it('rejects options that are not a plain object', () => {
    for (const options of [null, 'fast', 3, ['a']]) {
      expect(() => validateActOptions(options as never, 0)).toThrow(TestError);
    }
  });

  it('keeps naming schema and vision as capabilities act does not have', () => {
    expect(() => validateActOptions({ schema: {} } as never, 0)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/options\.schema/) }),
    );
    expect(() => validateActOptions({ vision: true } as never, 0)).toThrow(ConfigurationError);
  });
});
