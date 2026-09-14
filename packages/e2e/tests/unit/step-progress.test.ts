/** StepRecorder's live progress beyond the records: what a reporter hears while a step runs. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StepRecorder, type StepProgress } from '../../src/run/steps.ts';

function recorder(): { steps: StepRecorder; heard: StepProgress[] } {
  const heard: StepProgress[] = [];
  return { steps: new StepRecorder('attempt', { onProgress: (progress) => heard.push(progress) }), heard };
}

describe('StepRecorder.replaying', () => {
  it('tells reporters the cache took the step and handed it to the model, recording nothing', async () => {
    const { steps, heard } = recorder();
    await steps.run('agent', 'agent.act', 'pay', async () => {
      steps.replaying(true);
      steps.replaying(false);
    });
    expect(heard).toEqual([
      { phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' },
      { phase: 'replay', api: 'agent.act', active: true },
      { phase: 'replay', api: 'agent.act', active: false },
      expect.objectContaining({ phase: 'end', api: 'agent.act', modelCalls: 0 }),
    ]);
    expect(steps.all()[0]?.events).toEqual([]);
  });

  it('says nothing outside a running step', async () => {
    const { steps, heard } = recorder();
    steps.replaying(true);
    let late: (() => void) | undefined;
    await expect(
      steps.run('agent', 'agent.act', 'pay', async () => {
        late = () => steps.replaying(false);
        throw new Error('step timed out');
      }),
    ).rejects.toThrow('step timed out');
    late?.();
    expect(heard.map((progress) => progress.phase)).toEqual(['start', 'end']);
  });
});


describe('StepRecorder step source', () => {
  it('names the test line the step was called from when it knows the project root, and nothing otherwise', async () => {
    // The tests directory stands in for a project root: the runner's own frames lie outside it, as they do in a real project.
    const located = new StepRecorder('attempt', { projectRoot: path.join(process.cwd(), 'tests') });
    await located.run('locator', 'locator.tap', 'tap', async () => undefined);
    expect(located.all()[0]?.source?.file).toBe('unit/step-progress.test.ts');
    const { steps } = recorder();
    await steps.run('locator', 'locator.tap', 'tap', async () => undefined);
    expect(steps.all()[0]?.source).toBeUndefined();
  });
});
