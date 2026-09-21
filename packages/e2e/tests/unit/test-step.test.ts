/** `test.step`: the grouping step a test body opens on the published attempt. */

import { afterEach, describe, expect as vexpect, it } from 'vitest';
import { test } from '../../src/collect/registry.ts';
import { publishAttempt } from '../../src/expect/attempt.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { StepRecorder } from '../../src/run/steps.ts';

/** Publishes a fake attempt with its own recorder; `end()` clears it. */
function attempt() {
  const steps = new StepRecorder('attempt');
  const end = new AbortController();
  publishAttempt(
    {
      attemptId: 'attempt',
      testKind: 'test',
      assertionTimeout: 1000,
      budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)),
      steps,
    },
    end.signal,
  );
  return { steps, end: () => end.abort() };
}

describe('test.step', () => {
  let end: (() => void) | undefined;

  afterEach(() => {
    end?.();
    end = undefined;
  });

  it("records a `test.step` step with the title as its label, nests the steps the body opens, and resolves with the body's result", async () => {
    const published = attempt();
    end = published.end;
    const value = await test.step('sign in', async () => {
      await published.steps.run('locator', 'locator.tap', 'Sign in', async () => undefined);
      return 42;
    });
    vexpect(value).toBe(42);
    vexpect(published.steps.all().map((step) => [step.kind, step.api, step.label, step.parent, step.status])).toEqual([
      ['test', 'test.step', 'sign in', undefined, 'passed'],
      ['locator', 'locator.tap', 'Sign in', 'attempt:0', 'passed'],
    ]);
  });

  it('accepts a synchronous body', async () => {
    const published = attempt();
    end = published.end;
    await vexpect(test.step('count', () => 3)).resolves.toBe(3);
    vexpect(published.steps.all()[0]?.status).toBe('passed');
  });

  it('fails the step with what the body threw and rethrows it', async () => {
    const published = attempt();
    end = published.end;
    const cause = new Error('boom');
    await vexpect(
      test.step('explodes', () => {
        throw cause;
      }),
    ).rejects.toBe(cause);
    vexpect(published.steps.all()[0]).toMatchObject({ api: 'test.step', status: 'failed', error: { message: 'boom' } });
  });

  it('ends as cancelled, with no error, when test.skip() cuts its body short', async () => {
    const published = attempt();
    end = published.end;
    await vexpect(test.step('optional flow', () => test.skip('not supported here'))).rejects.toMatchObject({ reason: 'not supported here' });
    vexpect(published.steps.all()[0]).toMatchObject({ api: 'test.step', status: 'cancelled' });
    vexpect(published.steps.all()[0]?.error).toBeUndefined();
  });

  it('holds the title to the test title rule and the body to a function before opening a step', () => {
    const published = attempt();
    end = published.end;
    vexpect(() => test.step('', async () => undefined)).toThrow(
      vexpect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'test.step() title must be 1 through 512 UTF-8 bytes after NFC, got 0' }),
    );
    vexpect(() => test.step(7 as never, async () => undefined)).toThrow(vexpect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    vexpect(() => test.step('x', 'not a function' as never)).toThrow(vexpect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    vexpect(published.steps.all()).toEqual([]);
  });

  it('is a collection error outside a running test', () => {
    vexpect(() => test.step('early', async () => undefined)).toThrow(
      vexpect.objectContaining({ code: 'COLLECTION_ERROR', message: vexpect.stringContaining('inside a test body') }),
    );
  });
});
