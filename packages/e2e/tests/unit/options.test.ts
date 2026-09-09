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

  it('lists every unknown key, renamed or not', () => {
    expect(() => rejectUnknownOptions('longPress', { durationMs: 900, force: true }, ['timeout', 'duration'])).toThrow(
      expect.objectContaining({
        message: 'longPress options has no keys "durationMs" (now "duration"), "force"; it takes timeout, duration',
      }),
    );
  });

  it('rejects a bag that is not a plain object', () => {
    for (const options of [null, 'fast', 3, [1]]) {
      expect(() => rejectUnknownOptions('agent.assert', options as never, KNOWN)).toThrow(TestError);
    }
  });
});
