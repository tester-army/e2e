import { describe, expect, it } from 'vitest';

import { TestError } from '../../src/internal/errors.ts';
import { rejectUnknownOptions } from '../../src/internal/options.ts';

const KNOWN = ['timeout', 'interval', 'maxModelCalls', 'vision'];

describe('rejectUnknownOptions', () => {
  it('accepts an absent bag and one made of known keys only', () => {
    expect(() => rejectUnknownOptions('agent.waitFor', undefined, KNOWN)).not.toThrow();
    expect(() => rejectUnknownOptions('agent.waitFor', { timeout: 1, interval: 100 }, KNOWN)).not.toThrow();
  });

  it('names the rename for a duration that kept its Ms suffix', () => {
    expect(() => rejectUnknownOptions('agent.waitFor', { intervalMs: 100 }, KNOWN)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message:
          'agent.waitFor options has no key "intervalMs" (now "interval"); it takes timeout, interval, maxModelCalls, vision',
      }),
    );
  });

  it('rejects a bag that is not a plain object', () => {
    for (const options of [null, 'fast', 3, [1], new Date(), Object.create({ intervalMs: 100 })]) {
      expect(() => rejectUnknownOptions('agent.assert', options as never, KNOWN)).toThrow(TestError);
    }
  });

  it('sees a non-enumerable unknown key', () => {
    const options = Object.defineProperty({ timeout: 1 }, 'force', { value: true });
    expect(() => rejectUnknownOptions('agent.assert', options, KNOWN)).toThrow(
      expect.objectContaining({ message: 'agent.assert options has no key "force"; it takes timeout, interval, maxModelCalls, vision' }),
    );
  });

  it('throws the code the caller names', () => {
    expect(() => rejectUnknownOptions('filter', { hasNotText: 'Paid' }, ['hasText', 'has'], 'INVALID_LOCATOR')).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR' }),
    );
    expect(() => rejectUnknownOptions('filter', null as never, ['hasText', 'has'], 'INVALID_LOCATOR')).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATOR' }),
    );
  });
});
