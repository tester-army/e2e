import { describe, expect, it } from 'vitest';
import { web, type WebOptions } from '../../src/index.ts';

describe('web({ clock })', () => {
  const invalid = (clock: unknown) => () => web({ clock } as WebOptions);
  const refused = expect.objectContaining({ code: 'INVALID_CONFIG' });

  it('accepts dates, epoch zero, negative timestamps, and both modes', () => {
    for (const time of ['2032-01-02T03:04:05Z', '2032-01-02T08:34:05+05:30', 0, -1]) {
      for (const mode of [undefined, 'running', 'paused'] as const) {
        expect(() => web({ clock: { time, ...(mode === undefined ? {} : { mode }) } })).not.toThrow();
      }
    }
  });

  it('rejects a non-object, a missing time, and unsupported fields', () => {
    for (const clock of [null, [], '2032-01-02', 0, {}, { mode: 'paused' }, { time: 0, paused: true }]) {
      expect(invalid(clock)).toThrow(refused);
    }
  });

  it('rejects invalid dates, non-finite timestamps, and timestamps outside the date range', () => {
    for (const time of ['', 'not a date', NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1, null, true, new Date(), Symbol('time')]) {
      expect(invalid({ time })).toThrow(refused);
    }
  });

  it('rejects an unknown mode', () => {
    for (const mode of ['frozen', '', null, true, 0]) expect(invalid({ time: 0, mode })).toThrow(refused);
  });
});
