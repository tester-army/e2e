import { describe, expect as vexpect, it } from 'vitest';
import { z } from 'zod';
import { currentAttempt, publishAttempt } from '../../src/expect/attempt.ts';
import { expect as e2eExpect } from '../../src/expect/index.ts';
import { currentPollScope, pollLineage, PollScope, runInPollScope } from '../../src/expect/poll-scope.ts';
import { isAbandonedRejection } from '../../src/internal/abandoned.ts';
import { SoftFailures } from '../../src/expect/soft.ts';
import { ConfigurationError, TestError } from '../../src/internal/errors.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

/** Publishes a fake attempt for one test; `end()` clears it. */
function attempt(options: { assertionTimeout: number; deadlineMs: number }) {
  const cancel = new AbortController();
  const end = new AbortController();
  publishAttempt(
    {
      attemptId: 'attempt',
      testKind: 'test',
      assertionTimeout: options.assertionTimeout,
      budget: new AttemptBudget(cancel.signal, new Deadline(options.deadlineMs)),
      soft: new SoftFailures(),
    },
    end.signal,
  );
  return { cancel: () => cancel.abort(), end: () => end.abort() };
}

async function failsWith(run: () => Promise<void>, ...patterns: RegExp[]): Promise<string> {
  try {
    await run();
  } catch (error) {
    vexpect(error).toBeInstanceOf(TestError);
    vexpect((error as TestError).code).toBe('ASSERTION_FAILED');
    for (const pattern of patterns) vexpect((error as TestError).message).toMatch(pattern);
    return (error as TestError).message;
  }
  throw new Error('expected the poll to time out');
}

/** A read whose value settles after `settleAfter` samples. */
function settling<T>(before: T, after: T, settleAfter: number): { read: () => T; reads: () => number } {
  let reads = 0;
  return {
    read: () => {
      reads += 1;
      return reads > settleAfter ? after : before;
    },
    reads: () => reads,
  };
}

describe('expect.poll', () => {
  it('passes once the value settles and stops reading', async () => {
    const status = settling('running', 'done', 3);
    await e2eExpect.poll(status.read, { interval: 5 }).toBe('done');
    vexpect(status.reads()).toBe(4);
  });

  it('accepts an asynchronous read', async () => {
    const count = settling(0, 2, 2);
    await e2eExpect.poll(async () => count.read(), { interval: 5 }).toBeGreaterThan(1);
    vexpect(count.reads()).toBe(3);
  });

  it('times out with the last value in the message', async () => {
    const message = await failsWith(
      () => e2eExpect.poll(() => 'running', { timeout: 100, interval: 10 }).toBe('done'),
      /^expect\.poll\(\.\.\.\)\.toBe\(\.\.\.\) timed out after 100 ms\n/,
      /last: expected "running" to be "done"$/,
    );
    vexpect(message.split('\n')).toHaveLength(2);
  });

  it('.not flips the check', async () => {
    const status = settling('running', 'done', 2);
    await e2eExpect.poll(status.read, { interval: 5 }).not.toBe('running');
    vexpect(status.reads()).toBe(3);
    await failsWith(
      () => e2eExpect.poll(() => 'running', { timeout: 60, interval: 10 }).not.toBe('running'),
      /^expect\.poll\(\.\.\.\)\.not\.toBe\(\.\.\.\) timed out after 60 ms/,
      /last: expected "running" not to be "running"/,
    );
  });

  it('places the message option between the matcher line and the last sample', async () => {
    const message = await failsWith(
      () =>
        e2eExpect
          .poll(() => 'running', { timeout: 60, interval: 10, message: 'the batch never finished' })
          .toBe('done'),
    );
    vexpect(message.split('\n')).toEqual([
      'expect.poll(...).toBe(...) timed out after 60 ms',
      'the batch never finished',
      'last: expected "running" to be "done"',
    ]);
  });

  it('keeps polling through a throwing read and reports its error at the deadline', async () => {
    let reads = 0;
    await e2eExpect
      .poll(() => {
        reads += 1;
        if (reads < 3) throw new Error('connection refused');
        return 'done';
      }, { interval: 5 })
      .toBe('done');
    vexpect(reads).toBe(3);

    let failures = 0;
    await failsWith(
      () =>
        e2eExpect
          .poll(
            async (): Promise<string> => {
              failures += 1;
              throw new Error('connection refused');
            },
            { timeout: 80, interval: 10 },
          )
          .toBe('done'),
      /last: connection refused$/,
    );
    vexpect(failures).toBeGreaterThan(1);
  });

  it('bounds a hung read by the deadline', async () => {
    const started = Date.now();
    await failsWith(
      () => e2eExpect.poll(() => new Promise<string>(() => {}), { timeout: 100 }).toBe('done'),
      /timed out after 100 ms/,
      /last: no read completed$/,
    );
    vexpect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps the last completed sample when a later read hangs', async () => {
    let reads = 0;
    await failsWith(
      () =>
        e2eExpect
          .poll(() => {
            reads += 1;
            return reads === 1 ? 'running' : new Promise<string>(() => {});
          }, { timeout: 100, interval: 5 })
          .toBe('done'),
      /last: expected "running" to be "done"$/,
    );
    vexpect(reads).toBe(2);
  });

  it('honors the interval between samples', async () => {
    let reads = 0;
    await failsWith(() =>
      e2eExpect
        .poll(() => {
          reads += 1;
          return 'running';
        }, { timeout: 200, interval: 50 })
        .toBe('done'),
    );
    vexpect(reads).toBeGreaterThanOrEqual(3);
    vexpect(reads).toBeLessThanOrEqual(6);
  });

  it('runs every value matcher', async () => {
    const rows = settling<readonly { title: string }[]>([], [{ title: 'a' }, { title: 'b' }], 1);
    await e2eExpect.poll(rows.read, { interval: 5 }).toEqual([{ title: 'a' }, { title: 'b' }]);
    await e2eExpect.poll(rows.read, { interval: 5 }).toContain({ title: 'b' });
    await e2eExpect.poll(() => rows.read().length, { interval: 5 }).toBeGreaterThan(1);
    await e2eExpect.poll(() => 'order #42', { interval: 5 }).toMatch(/#\d+/);
    await e2eExpect.poll(() => null, { interval: 5 }).toBeNull();
    await e2eExpect.poll(() => undefined, { interval: 5 }).toBeUndefined();
    await e2eExpect.poll(() => 0, { interval: 5 }).toBeFalsy();
    await e2eExpect.poll(() => 1, { interval: 5 }).toBeTruthy();
    await e2eExpect.poll(() => 'x', { interval: 5 }).toBeDefined();
    await e2eExpect.poll(() => 1, { interval: 5 }).toBeLessThan(2);
    await e2eExpect.poll(rows.read, { interval: 5 }).toMatchObject([{ title: 'a' }, {}]);
    await e2eExpect.poll(rows.read, { interval: 5 }).toHaveLength(2);
    await e2eExpect.poll(rows.read, { interval: 5 }).toHaveProperty('1.title', 'b');
    await e2eExpect.poll(rows.read, { interval: 5 }).toHaveProperty([0, 'title']);
    await e2eExpect.poll(rows.read, { interval: 5 }).toEqual(e2eExpect.arrayContaining([{ title: e2eExpect.any(String) }]));
  });

  it('polls the new matchers until they hold and reports their last failure', async () => {
    const rows = settling<string[]>(['a'], ['a', 'b'], 2);
    await e2eExpect.poll(rows.read, { interval: 5 }).toHaveLength(2);
    vexpect(rows.reads()).toBe(3);
    await failsWith(
      () => e2eExpect.poll(() => ({ status: 'running' }), { timeout: 60, interval: 10 }).toHaveProperty('status', 'done'),
      /^expect\.poll\(\.\.\.\)\.toHaveProperty\(\.\.\.\) timed out after 60 ms/,
      /last: expected property "status" of {"status":"running"} to equal "done", got "running"/,
    );
    await failsWith(
      () => e2eExpect.poll(() => ({ a: 1 }), { timeout: 60, interval: 10 }).not.toMatchObject({ a: 1 }),
      /last: expected {"a":1} not to match object {"a":1}/,
    );
  });

  it('treats a matcher type complaint as not yet, like any other failing sample', async () => {
    const value = settling<unknown>(42, 'hello world', 1);
    await e2eExpect.poll(value.read, { interval: 5 }).toContain('world');
    vexpect(value.reads()).toBe(2);
  });

  it('a negated global regexp never passes on an unchanged matching value', async () => {
    await failsWith(
      () => e2eExpect.poll(() => 'done', { timeout: 60, interval: 5 }).not.toMatch(/done/g),
      /last: expected "done" not to match/,
    );
  });

  it('refuses a timeout or interval that could never expire, before the first read', () => {
    const invalid = (run: () => unknown, pattern: RegExp): void => {
      try {
        run();
      } catch (error) {
        vexpect(error).toBeInstanceOf(ConfigurationError);
        vexpect((error as ConfigurationError).code).toBe('INVALID_CONFIG');
        vexpect((error as ConfigurationError).message).toMatch(pattern);
        return;
      }
      throw new Error('expected expect.poll to refuse the option');
    };
    invalid(() => e2eExpect.poll(() => 1, { timeout: Number.NaN }), /timeout.*got NaN/);
    invalid(() => e2eExpect.poll(() => 1, { timeout: Number.POSITIVE_INFINITY }), /timeout.*got Infinity/);
    invalid(() => e2eExpect.poll(() => 1, { timeout: -1 }), /timeout.*got -1/);
    invalid(() => e2eExpect.poll(() => 1, { interval: Number.NaN }), /interval.*got NaN/);
    invalid(() => e2eExpect.poll(() => 1, { interval: 0 }), /interval.*got 0/);
    invalid(() => e2eExpect.poll(() => 1, { interval: -5 }), /interval.*got -5/);
    e2eExpect.poll(() => 1, { timeout: 0, interval: 1 });
  });

  describe('inside an attempt', () => {
    it('defaults the timeout to the attempt assertionTimeout until the attempt ends', async () => {
      const live = attempt({ assertionTimeout: 80, deadlineMs: 10_000 });
      try {
        await failsWith(
          () => e2eExpect.poll(() => 'running', { interval: 10 }).toBe('done'),
          /timed out after 80 ms/,
        );
      } finally {
        live.end();
      }
      vexpect(currentAttempt()).toBeUndefined();
    });

    it('caps the poll at the attempt deadline', async () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 80 });
      try {
        const started = Date.now();
        await failsWith(
          () => e2eExpect.poll(() => 'running', { timeout: 15_000, interval: 10 }).toBe('done'),
          /stopped at the attempt deadline after \d+ ms/,
          /last: expected "running" to be "done"/,
        );
        vexpect(Date.now() - started).toBeLessThan(1000);
      } finally {
        live.end();
      }
    });

    it('stops reading the moment the attempt is cancelled', async () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      let reads = 0;
      try {
        const poll = e2eExpect
          .poll(() => {
            reads += 1;
            return 'running';
          }, { timeout: 15_000, interval: 5 })
          .toBe('done');
        setTimeout(live.cancel, 30);
        await vexpect(poll).rejects.toMatchObject({ code: 'CANCELLED', category: 'infrastructure' });
        const readsAtCancel = reads;
        await new Promise((resolve) => setTimeout(resolve, 50));
        vexpect(reads).toBe(readsAtCancel);
      } finally {
        live.end();
      }
    });

    it('cuts a read in flight when the attempt is cancelled', async () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      try {
        const poll = e2eExpect.poll(() => new Promise<string>(() => {}), { timeout: 15_000 }).toBe('done');
        setTimeout(live.cancel, 20);
        await vexpect(poll).rejects.toMatchObject({ code: 'CANCELLED' });
      } finally {
        live.end();
      }
    });

    it('refuses a second live attempt in the same process', () => {
      const live = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      try {
        vexpect(() => attempt({ assertionTimeout: 5000, deadlineMs: 10_000 })).toThrowError(
          /attempt attempt started while attempt attempt was still running/,
        );
      } finally {
        live.end();
      }
      const next = attempt({ assertionTimeout: 5000, deadlineMs: 10_000 });
      next.end();
      vexpect(currentAttempt()).toBeUndefined();
    });
  });
});

describe('expect.poll in a poll scope', () => {
  /** A read that counts its calls and never passes `toBe('done')`. */
  function counting(): { read: () => string; reads: () => number } {
    let reads = 0;
    return {
      read: () => {
        reads += 1;
        return 'running';
      },
      reads: () => reads,
    };
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (cause: unknown) => cause,
    );
  }

  it('fails the phase that returned before its poll finished, at the line of the call, and cancels it', async () => {
    const scope = new PollScope('the test body');
    const status = counting();
    const poll = runInPollScope(scope, () => e2eExpect.poll(status.read, { timeout: 5000, interval: 5 }).toBe('done'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = scope.close();
    vexpect(error).toBeInstanceOf(TestError);
    vexpect(error?.code).toBe('STEP_NOT_AWAITED');
    vexpect(error?.message).toBe(
      'the test body returned before expect.poll(...).toBe(...) finished; put `await` in front of every expect.poll call',
    );
    vexpect(error?.stack).toContain('expect-poll.test.ts');
    const rejection = await rejectionOf(poll);
    vexpect(rejection).toMatchObject({ code: 'CANCELLED' });
    vexpect(isAbandonedRejection(rejection)).toBe(true);
    const readsAtClose = status.reads();
    await new Promise((resolve) => setTimeout(resolve, 30));
    vexpect(status.reads()).toBe(readsAtClose);
  });

  it('names one poll and counts the rest, negation included', async () => {
    const scope = new PollScope('the afterEach hook');
    const polls = runInPollScope(scope, () => [
      e2eExpect.poll(() => 1, { timeout: 5000 }).not.toBe(1),
      e2eExpect.poll(() => 1, { timeout: 5000 }).toBe(2),
    ]);
    const error = scope.close();
    vexpect(error?.message).toMatch(/^the afterEach hook returned before expect\.poll\(\.\.\.\)\.not\.toBe\(\.\.\.\) and 1 more finished/);
    vexpect(scope.close()).toBeUndefined();
    await Promise.allSettled(polls);
  });

  it('a poll that would have passed still fails its phase when not awaited', async () => {
    const scope = new PollScope('the test body');
    const poll = runInPollScope(scope, () => e2eExpect.poll(settling('running', 'done', 3).read, { interval: 20 }).toBe('done'));
    vexpect(scope.close()?.code).toBe('STEP_NOT_AWAITED');
    await vexpect(poll).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('closes quietly when every poll was awaited, whatever its outcome', async () => {
    const scope = new PollScope('the test body');
    await runInPollScope(scope, async () => {
      await e2eExpect.poll(settling('running', 'done', 1).read, { interval: 5 }).toBe('done');
      await failsWith(() => e2eExpect.poll(() => 'running', { timeout: 30, interval: 5 }).toBe('done'), /timed out after 30 ms/);
    });
    vexpect(scope.close()).toBeUndefined();
  });

  it('a poll belongs to the phase that started it, not to the phase running when it is called', async () => {
    const timedOut = new PollScope('the test body');
    const status = counting();
    let resume!: () => void;
    const leftover = runInPollScope(timedOut, async () => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return e2eExpect.poll(status.read, { timeout: 5000 }).toBe('done');
    });
    timedOut.close();
    const next = new PollScope('the test body');
    await runInPollScope(next, async () => {
      resume();
      const rejection = await rejectionOf(leftover);
      vexpect(rejection).toMatchObject({ code: 'CANCELLED' });
      vexpect(isAbandonedRejection(rejection)).toBe(true);
    });
    vexpect(status.reads()).toBe(0);
    vexpect(next.close()).toBeUndefined();
  });

  it('hands a lineage over to the scope current when it is handed over', async () => {
    const body = new PollScope('the test body');
    const lineage = runInPollScope(body, () => pollLineage());
    vexpect(lineage.run(() => currentPollScope())).toBe(body);
    body.close();
    const teardown = new PollScope('the fixture "workspace" teardown');
    runInPollScope(teardown, () => lineage.handOver());
    const poll = lineage.run(() => e2eExpect.poll(() => 'running', { timeout: 5000 }).toBe('done'));
    vexpect(teardown.close()?.message).toMatch(/^the fixture "workspace" teardown returned before/);
    await rejectionOf(poll);
  });

  it('marks the rejection of a promise derived from an abandoned poll', async () => {
    const scope = new PollScope('the test body');
    const derived = runInPollScope(scope, () =>
      e2eExpect.poll(() => 'running', { timeout: 5000 }).toBe('done').then(() => 'never'),
    );
    scope.close();
    vexpect(isAbandonedRejection(await rejectionOf(derived))).toBe(true);
  });

  it('stays out of the way of a poll outside any scope', async () => {
    vexpect(currentPollScope()).toBeUndefined();
    const poll = e2eExpect.poll(settling('running', 'done', 2).read, { interval: 5 }).toBe('done');
    const scope = new PollScope('the test body');
    vexpect(scope.close()).toBeUndefined();
    await poll;
  });
});

describe('expect.poll toMatchSchema', () => {
  it('resolves to the schema output of the first read that passes', async () => {
    const { read } = settling<unknown>({ status: 'pending' }, { status: 'done', items: [1] }, 2);
    const done = z.object({ status: z.literal('done'), items: z.array(z.number()), page: z.number().default(1) });
    vexpect(await e2eExpect.poll(read, { interval: 1 }).toMatchSchema(done)).toEqual({ status: 'done', items: [1], page: 1 });
  });
});
