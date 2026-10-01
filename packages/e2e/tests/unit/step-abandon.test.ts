/** StepRecorder.abandonRunning: the steps a test body returned without awaiting. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAbandonedRejection } from '../../src/internal/abandoned.ts';
import { StepRecorder, type StepProgress } from '../../src/run/steps.ts';

function recorder(): { steps: StepRecorder; heard: StepProgress[] } {
  const heard: StepProgress[] = [];
  return {
    steps: new StepRecorder('attempt', { projectRoot: path.join(process.cwd(), 'tests'), onProgress: (progress) => heard.push(progress) }),
    heard,
  };
}

function gate(): { promise: Promise<void>; open: () => void; fail: (cause: Error) => void } {
  let open!: () => void;
  let fail!: (cause: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

describe('StepRecorder.abandonRunning', () => {
  it('returns nothing when every step was awaited', async () => {
    const { steps } = recorder();
    await steps.run('app', 'app.open', '/', async () => {});
    expect(steps.abandonRunning()).toBeUndefined();
    expect(steps.all()[0]?.status).toBe('passed');
    const cause = new Error('awaited and failed');
    await expect(steps.run('app', 'app.open', '/', () => Promise.reject(cause))).rejects.toBe(cause);
    expect(isAbandonedRejection(cause)).toBe(false);
  });

  it('fails the running step at the line it was called from and observes its later rejection', async () => {
    const { steps, heard } = recorder();
    const body = gate();
    const step = steps.run('agent', 'agent.act', 'go to the contact form', () => body.promise);

    const failure = steps.abandonRunning();
    expect(failure).toMatchObject({ category: 'test', code: 'STEP_NOT_AWAITED' });
    expect(failure?.message).toBe('the test body returned before agent.act "go to the contact form" finished; put `await` in front of every step call');
    expect(failure?.stack).toContain('step-abandon.test.ts');

    const record = steps.all()[0]!;
    expect(record.status).toBe('failed');
    expect(record.error).toMatchObject({ code: 'STEP_NOT_AWAITED', source: { file: 'unit/step-abandon.test.ts' } });
    expect(heard.map((progress) => progress.phase)).toEqual(['start', 'end']);
    expect(steps.completed()).toEqual([]);

    const cause = new Error('no attempt is running');
    expect(isAbandonedRejection(cause)).toBe(false);
    body.fail(cause);
    await expect(step).rejects.toThrow('no attempt is running');
    expect(isAbandonedRejection(cause)).toBe(true);
    expect(record).toMatchObject({ status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
    expect(heard.map((progress) => progress.phase)).toEqual(['start', 'end']);
    expect(steps.completed()).toEqual([record]);
    expect(steps.abandonRunning()).toBeUndefined();
  });

  it('settles once every abandoned step has, however it did', async () => {
    const { steps } = recorder();
    const first = gate();
    const second = gate();
    void steps.run('app', 'app.open', '/', () => first.promise);
    void steps.run('agent', 'agent.act', 'pay', () => second.promise);
    steps.abandonRunning();
    let settled = false;
    const wait = steps.settleAbandoned().then(() => {
      settled = true;
    });
    first.fail(new Error('cancelled'));
    await Promise.resolve();
    expect(settled).toBe(false);
    second.open();
    await wait;
    expect(settled).toBe(true);
    expect(steps.all().map((step) => step.status)).toEqual(['failed', 'failed']);
  });

  it('keeps an abandoned step failed when it later passes, and never counts it as verified', async () => {
    const { steps } = recorder();
    const body = gate();
    const step = steps.run('assertion', 'expect.toBeVisible', 'button "Save"', () => body.promise, { verifies: true });
    steps.abandonRunning();
    body.open();
    await step;
    expect(steps.all()[0]?.status).toBe('failed');
    expect(steps.lastVerifiedStepIndex).toBe(-1);
  });

  it('names the first step and counts the rest', async () => {
    const { steps } = recorder();
    const first = gate();
    const second = gate();
    const a = steps.run('app', 'app.open', '/', () => first.promise);
    const b = steps.run('agent', 'agent.act', 'x'.repeat(100), () => second.promise);
    const failure = steps.abandonRunning();
    expect(failure?.message).toContain('before app.open "/" and 1 more finished');
    expect(steps.all()[1]?.error?.message).toContain(`agent.act "${'x'.repeat(77)}..." finished`);
    first.open();
    second.open();
    await Promise.all([a, b]);
  });
});
