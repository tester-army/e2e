/** A `test.extend()` chain whose later fixture fails to set up still releases the ones before it. */

import { describe, expect, it, vi } from 'vitest';
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
  it('retains cleanup when the attempt aborts immediately after use provides a value', async () => {
    const abort = new AbortController();
    const log: string[] = [];
    const extended = createExtendedFixtures([
      { name: 'ready', fn: async (_fixtures, use) => {
        const released = use('ready');
        abort.abort();
        await released;
        log.push('teardown:ready');
      } },
      logged(log, 'later', 'later'),
    ], {}, 'toy', abort.signal);
    await expect(extended.setUp()).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    const teardowns = extended.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['ready']);
    await teardowns[0]!.run();
    expect(log).toEqual(['teardown:ready']);
  });

  it('abandons setup on abort before teardown is taken, while keeping a provided fixture for cleanup', async () => {
    const abort = new AbortController();
    let finishSetup!: () => void;
    const waiting = new Promise<void>((resolve) => { finishSetup = resolve; });
    const log: string[] = [];
    const extended = createExtendedFixtures([
      logged(log, 'ready', 'ready'),
      { name: 'slow', fn: async (_fixtures, use) => {
        log.push('setup:slow');
        await waiting;
        await use('slow');
        log.push('teardown:slow');
      } },
      logged(log, 'later', 'later'),
    ], {}, 'toy', abort.signal);
    const continuation = extended.setUp().then(() => { log.push('body'); });
    const stopped = expect(continuation).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    await vi.waitFor(() => expect(log).toEqual(['setup:ready', 'setup:slow']));
    abort.abort();
    finishSetup();
    await stopped;
    expect(log).toEqual(['setup:ready', 'setup:slow', 'teardown:slow']);
    const teardowns = extended.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['ready']);
    await teardowns[0]!.run();
    expect(log.at(-1)).toBe('teardown:ready');
  });

  it('stops abandoned setup before later fixtures or the body, while releasing the late fixture', async () => {
    const log: string[] = [];
    let finishSetup!: () => void;
    const waiting = new Promise<void>((resolve) => { finishSetup = resolve; });
    const extended = createExtendedFixtures([
      {
        name: 'slow',
        fn: async (_fixtures, use) => {
          log.push('setup:slow');
          await waiting;
          await use('slow');
          log.push('teardown:slow');
        },
      },
      logged(log, 'later', 'later'),
    ], {}, 'toy');
    const continuation = extended.setUp().then(() => { log.push('body'); });
    const stopped = expect(continuation).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    await Promise.resolve();
    expect(extended.teardowns()).toEqual([]);
    finishSetup();
    await stopped;
    expect(log).toEqual(['setup:slow', 'teardown:slow']);
  });

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
