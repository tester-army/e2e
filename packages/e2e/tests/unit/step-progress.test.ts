/** StepRecorder's live progress beyond the records: what a reporter hears while a step runs. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StepRecorder, type StepProgress } from '../../src/run/steps.ts';
import { AgentError } from '../../src/agent/error.ts';

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
    expect(heard).toMatchObject([
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

describe('StepRecorder.activity', () => {
  it('announces what the running step waits on, recording nothing', async () => {
    const { steps, heard } = recorder();
    await steps.run('agent', 'agent.act', 'pay', async () => {
      steps.activity('action');
      steps.activity('observe');
    });
    expect(heard).toMatchObject([
      { phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' },
      { phase: 'activity', api: 'agent.act', activity: 'action' },
      { phase: 'activity', api: 'agent.act', activity: 'observe' },
      expect.objectContaining({ phase: 'end', api: 'agent.act', modelCalls: 0 }),
    ]);
    expect(steps.all()[0]?.events).toEqual([]);
  });

  it('says nothing outside a running step', () => {
    const { steps, heard } = recorder();
    steps.activity('observe');
    expect(heard).toEqual([]);
  });
});

describe('StepRecorder progress identity', () => {
  it('keeps every nested phase attached to its report step and the shared retry attempt', async () => {
    const heard: StepProgress[] = [];
    const steps = new StepRecorder('member-attempt', {
      attempt: { id: 'group-attempt', index: 1 },
      onProgress: (progress) => heard.push(progress),
    });
    await steps.run('agent', 'agent.act', 'outer', async () => {
      steps.replaying(true);
      await steps.run('agent', 'agent.act', 'inner', async () => {
        steps.activity('observe');
        steps.recordEvent({ kind: 'observation', startedAt: new Date().toISOString(), durationMs: 0, status: 'passed' });
      });
      steps.replaying(false);
    });
    expect(heard.map((progress) => progress.identity?.stepIndex)).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
    for (const progress of heard) {
      const record = steps.all().find((step) => step.id === progress.identity?.stepId);
      expect(record).toBeDefined();
      expect(progress.identity).toEqual({
        attemptId: 'group-attempt',
        attemptIndex: 1,
        stepId: record!.id,
        stepIndex: record!.index,
        ...(record!.parent === undefined ? {} : { parentStepId: record!.parent }),
      });
    }
  });

  it.each([
    { code: 'AUTH_CREDENTIAL_UNAVAILABLE', blocked: true, status: 'blocked' },
    { code: 'CANCELLED', blocked: false, status: 'cancelled' },
  ] as const)('publishes the redacted $status error as the step ends', async ({ code, blocked, status }) => {
    const heard: StepProgress[] = [];
    const steps = new StepRecorder('attempt', {
      onProgress: (progress) => heard.push(progress),
      redact: (text) => text.replaceAll('private-value', '[REDACTED]'),
    });
    await expect(steps.run('agent', 'agent.act', 'login', async () => {
      steps.attachAgentDetails({ explanation: 'private-value is unavailable' });
      throw new AgentError(code, 'private-value is unavailable', { blocked });
    })).rejects.toThrow(AgentError);
    expect(heard.at(-1)).toMatchObject({
      phase: 'end',
      identity: { attemptId: 'attempt', attemptIndex: 0, stepId: 'attempt:0', stepIndex: 0 },
      status,
      error: { code, message: '[REDACTED] is unavailable' },
      explanation: '[REDACTED] is unavailable',
    });
    expect(JSON.stringify(heard)).not.toContain('private-value');
    expect(heard.at(-1)).toHaveProperty('error', steps.all()[0]!.error);
  });
});
