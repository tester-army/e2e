import { describe, expect as vexpect, it } from 'vitest';
import { publishAttempt } from '../../src/expect/attempt.ts';
import { expect as e2eExpect } from '../../src/expect/index.ts';
import { SoftFailures, soften } from '../../src/expect/soft.ts';
import { TestError } from '../../src/internal/errors.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';

/** Publishes a fake attempt with its own soft-failure collector; `end()` clears it. */
function attempt(): { soft: SoftFailures; end: () => void } {
  const end = new AbortController();
  const soft = new SoftFailures();
  publishAttempt(
    {
      attemptId: 'attempt',
      testKind: 'test',
      assertionTimeout: 5000,
      budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)),
      soft,
    },
    end.signal,
  );
  return { soft, end: () => end.abort() };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('expect.soft', () => {
  it('throws like expect outside an attempt', () => {
    const error = thrownBy(() => e2eExpect.soft(1).toBe(2));
    vexpect(error).toBeInstanceOf(TestError);
    vexpect((error as TestError).message).toBe('expected 1 to be 2');
    e2eExpect.soft(1).toBe(1);
  });

  it('keeps failures on the attempt, lets the caller continue, and fails once with every message in order', () => {
    const live = attempt();
    try {
      e2eExpect.soft(1).toBe(2);
      e2eExpect.soft('a', 'the label').not.toBe('a');
      e2eExpect.soft(3).toBe(3);
      e2eExpect.soft({ a: 1 }).toMatchObject({ b: 2 });
      const error = live.soft.close();
      vexpect(error).toBeInstanceOf(TestError);
      vexpect(error?.code).toBe('ASSERTION_FAILED');
      vexpect(error?.message.split('\n')).toEqual([
        '3 soft assertions failed',
        '1. expected 1 to be 2',
        '2. the label: expected "a" not to be "a"',
        '3. expected {"a":1} to match object {"b":2}',
      ]);
    } finally {
      live.end();
    }
  });

  it('closes with nothing when every soft matcher passed, and a lone failure reads in the singular', () => {
    const live = attempt();
    try {
      e2eExpect.soft(1).toBe(1);
      vexpect(live.soft.close()).toBeUndefined();
    } finally {
      live.end();
    }
    const again = attempt();
    try {
      e2eExpect.soft(1).toBe(2);
      vexpect(again.soft.close()?.message).toMatch(/^1 soft assertion failed\n1\. expected 1 to be 2$/);
    } finally {
      again.end();
    }
  });

  it('indents a multi-line failure under its number', () => {
    const live = attempt();
    try {
      live.soft.keep(new TestError('ASSERTION_FAILED', 'expect.toHaveText failed\nlocator: getByRole(\'status\')'));
      vexpect(live.soft.close()?.message).toBe(
        "1 soft assertion failed\n1. expect.toHaveText failed\n   locator: getByRole('status')",
      );
    } finally {
      live.end();
    }
  });

  it('unwinds through the first failure, so the error points at the first expect.soft line', () => {
    const live = attempt();
    try {
      e2eExpect.soft(1).toBe(2);
      e2eExpect.soft(2).toBe(3);
      const error = live.soft.close();
      vexpect(error?.stack?.startsWith(`TestError: ${error.message}\n`)).toBe(true);
      vexpect(error?.stack).toContain('expect-soft.test.ts');
    } finally {
      live.end();
    }
  });

  it('throws once the collection is closed, as an afterEach hook finds it', () => {
    const live = attempt();
    try {
      live.soft.close();
      const error = thrownBy(() => e2eExpect.soft(1).toBe(2));
      vexpect((error as TestError).message).toBe('expected 1 to be 2');
    } finally {
      live.end();
    }
  });

  it('hands each failure out once, so a second close after a timed-out body returns nothing', () => {
    const live = attempt();
    try {
      e2eExpect.soft(1).toBe(2);
      vexpect(live.soft.close()?.message).toContain('expected 1 to be 2');
      vexpect(live.soft.close()).toBeUndefined();
    } finally {
      live.end();
    }
  });

  it('keeps a usage failure too, since the matcher could not pass', () => {
    const live = attempt();
    try {
      e2eExpect.soft(42 as unknown as string).toContain('x');
      vexpect(live.soft.close()?.message).toContain('toContain requires a string or collection');
    } finally {
      live.end();
    }
  });

  it('soften keeps an async assertion failure, softens .not, and lets other errors through', async () => {
    const live = attempt();
    try {
      const calls: string[] = [];
      const fake = {
        get not() {
          calls.push('not');
          return fake;
        },
        async toBeVisible(): Promise<void> {
          calls.push('toBeVisible');
          throw new TestError('ASSERTION_FAILED', 'expect.toBeVisible failed');
        },
        async toHaveCount(n: number): Promise<number> {
          calls.push(`toHaveCount ${n}`);
          return n;
        },
        boom(): void {
          throw new Error('not an assertion');
        },
        label: 'plain',
      };
      const soft = soften(fake);
      await soft.not.toBeVisible();
      vexpect(await soft.toHaveCount(3)).toBe(3);
      vexpect(soft.label).toBe('plain');
      vexpect(thrownBy(() => soft.boom())).toMatchObject({ message: 'not an assertion' });
      vexpect(calls).toEqual(['not', 'toBeVisible', 'toHaveCount 3']);
      vexpect(live.soft.close()?.message).toBe('1 soft assertion failed\n1. expect.toBeVisible failed');
    } finally {
      live.end();
    }
  });
});
