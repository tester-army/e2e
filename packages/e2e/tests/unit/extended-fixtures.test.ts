/** A `test.extend()` chain whose later fixture fails to set up still releases the ones before it. */

import { describe, expect, it } from 'vitest';
import type { FixtureDefinition } from '../../src/collect/registry.ts';
import { createExtendedFixtures } from '../../src/run/extended-fixtures.ts';

/** A fixture that logs its setup, hands `value` to the test, and logs its teardown. */
function logged(log: string[], name: string, value: unknown): FixtureDefinition {
  return {
    name,
    fn: async (_fixtures, use) => {
      log.push(`setup:${name}`);
      await use(value);
      log.push(`teardown:${name}`);
    },
  };
}

describe('createExtendedFixtures', () => {
  it('tears down the fixtures set up before a later one throws, last first, and never the one that threw', async () => {
    const log: string[] = [];
    const fixtures = {};
    const extended = createExtendedFixtures(
      [
        logged(log, 'a', 'A'),
        logged(log, 'b', 'B'),
        {
          name: 'c',
          fn: async () => {
            log.push('setup:c');
            throw new Error('c failed');
          },
        },
        logged(log, 'd', 'D'),
      ],
      fixtures,
      'toy',
    );
    await expect(extended.setUp()).rejects.toThrow('c failed');
    const teardowns = extended.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['b', 'a']);
    for (const teardown of teardowns) await teardown.run();
    expect(log).toEqual(['setup:a', 'setup:b', 'setup:c', 'teardown:b', 'teardown:a']);
    expect(fixtures).toEqual({ a: 'A', b: 'B' });
  });
});
