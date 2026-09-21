/** StepRecorder nesting: a step run inside another step's body records it as its parent. */

import { describe, expect, it } from 'vitest';
import { StepRecorder, type StepProgress } from '../../src/run/steps.ts';

function recorder(): { steps: StepRecorder; heard: StepProgress[] } {
  const heard: StepProgress[] = [];
  return { steps: new StepRecorder('attempt', { onProgress: (progress) => heard.push(progress) }), heard };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('StepRecorder nesting', () => {
  it('records the enclosing step as parent, in start order, and tells reporters through the identity', async () => {
    const { steps, heard } = recorder();
    const result = await steps.run('test', 'test.step', 'sign in', async () => {
      await steps.run('locator', 'locator.fill', 'Email', async () => undefined);
      await steps.run('test', 'test.step', 'submit', async () => {
        await steps.run('locator', 'locator.tap', 'Sign in', async () => undefined);
      });
      return 'signed in';
    });
    await steps.run('assertion', 'expect.toBeVisible', 'Dashboard', async () => undefined);

    expect(result).toBe('signed in');
    expect(steps.all().map((step) => [step.index, step.api, step.parent])).toEqual([
      [0, 'test.step', undefined],
      [1, 'locator.fill', 'attempt:0'],
      [2, 'test.step', 'attempt:0'],
      [3, 'locator.tap', 'attempt:2'],
      [4, 'expect.toBeVisible', undefined],
    ]);
    expect(steps.all().every((step) => step.status === 'passed')).toBe(true);
    expect(heard.filter((progress) => progress.phase === 'start').map((progress) => progress.identity?.parentStepId)).toEqual([
      undefined,
      'attempt:0',
      'attempt:0',
      'attempt:2',
      undefined,
    ]);
  });

  it('lists a grouping step as completed only once its body has, after the steps it wrapped', async () => {
    const { steps } = recorder();
    let inside: string[] = [];
    await steps.run('test', 'test.step', 'outer', async () => {
      await steps.run('app', 'app.open', '/', async () => undefined);
      inside = steps.completed().map((step) => step.api);
    });
    expect(inside).toEqual(['app.open']);
    expect(steps.completed().map((step) => step.api)).toEqual(['test.step', 'app.open']);
  });

  it('fails a step whose body returned before a step it called finished, naming both', async () => {
    const { steps, heard } = recorder();
    const child = gate();
    let abandoned: Promise<void> | undefined;
    await expect(
      steps.run('test', 'test.step', 'careless', async () => {
        abandoned = steps.run('locator', 'locator.tap', 'Save', () => child.promise);
      }),
    ).rejects.toMatchObject({
      code: 'STEP_NOT_AWAITED',
      message: 'test.step "careless" returned before locator.tap "Save" finished; put `await` in front of every step call',
    });

    const [parent, tap] = steps.all();
    expect(parent).toMatchObject({ status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
    expect(tap).toMatchObject({ parent: 'attempt:0', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
    expect(steps.hasAbandoned).toBe(true);
    // The test body abandoned nothing itself; the parent already dealt with its child.
    expect(steps.abandonRunning()).toBeUndefined();
    expect(heard.map((progress) => [progress.phase, progress.identity?.stepIndex])).toEqual([
      ['start', 0],
      ['start', 1],
      ['end', 1],
      ['end', 0],
    ]);

    child.open();
    await expect(abandoned).resolves.toBeUndefined();
    await steps.settleAbandoned();
    expect(tap?.status).toBe('failed');
  });

  it('fails a child left running by a body that threw beside the body\'s own error', async () => {
    const { steps } = recorder();
    const child = gate();
    const cause = new Error('gave up early');
    await expect(
      steps.run('test', 'test.step', 'hasty', async () => {
        void steps.run('locator', 'locator.tap', 'Save', () => child.promise);
        throw cause;
      }),
    ).rejects.toBe(cause);
    const [parent, tap] = steps.all();
    expect(parent).toMatchObject({ status: 'failed', error: { message: 'gave up early' } });
    expect(tap).toMatchObject({
      status: 'failed',
      error: { code: 'STEP_NOT_AWAITED', message: expect.stringContaining('test.step "hasty" returned before locator.tap "Save" finished') },
    });
    expect(steps.abandonRunning()).toBeUndefined();
    child.open();
    await steps.settleAbandoned();
  });

  it('keeps a child that failed on its own as the failure, not a missing await', async () => {
    const { steps } = recorder();
    const cause = new Error('no such button');
    await expect(
      steps.run('test', 'test.step', 'outer', () => steps.run('locator', 'locator.tap', 'Ghost', () => Promise.reject(cause))),
    ).rejects.toBe(cause);
    expect(steps.all().map((step) => [step.api, step.status, step.error?.message])).toEqual([
      ['test.step', 'failed', 'no such button'],
      ['locator.tap', 'failed', 'no such button'],
    ]);
    expect(steps.hasAbandoned).toBe(false);
  });
});
