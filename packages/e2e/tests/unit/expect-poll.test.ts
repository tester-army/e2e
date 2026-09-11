import { describe, expect as vexpect, it } from 'vitest';
import { currentAttempt, publishAttempt } from '../../src/expect/attempt.ts';
import { expect as e2eExpect } from '../../src/expect/index.ts';
import { ConfigurationError, TestError } from '../../src/internal/errors.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';

/** Publishes a fake attempt for one test; `end()` clears it. */
function attempt(options: { assertionTimeout: number; deadlineMs: number }) {
  const cancel = new AbortController();
  const end = new AbortController();
  publishAttempt(
    {
      attemptId: 'attempt',
      assertionTimeout: options.assertionTimeout,
      budget: new AttemptBudget(cancel.signal, new Deadline(options.deadlineMs)),
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
