/**
 * Which steps may confirm a staged action trace (cache/context.ts): the ones
 * minted as verification steps, whatever their kind or api name.
 */

import { describe, expect, it } from 'vitest';
import { StepRecorder } from '../../src/run/steps.ts';

const pass = async (): Promise<void> => undefined;

describe('StepRecorder.lastVerifiedStepIndex', () => {
  it('is -1 until a verification step passes', async () => {
    const steps = new StepRecorder('attempt');
    expect(steps.lastVerifiedStepIndex).toBe(-1);
    await steps.run('agent', 'agent.act', 'add an expense', pass);
    await steps.run('app', 'app.open', '/', pass);
    await steps.run('locator', 'locator.click', 'button "Save"', pass);
    expect(steps.lastVerifiedStepIndex).toBe(-1);
  });

  it('advances to each passed verification step, whatever its kind', async () => {
    const steps = new StepRecorder('attempt');
    await steps.run('agent', 'agent.act', 'add an expense', pass);
    await steps.run('assertion', 'expect.toBeVisible', 'the new row', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(1);
    await steps.run('agent', 'agent.act', 'approve it', pass);
    await steps.run('agent', 'agent.assert', 'the row reads approved', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(3);
    await steps.run('locator', 'locator.waitFor', 'toast → visible', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(4);
  });

  it('does not advance on a verification step that failed', async () => {
    const steps = new StepRecorder('attempt');
    await steps.run('assertion', 'expect.toBeVisible', 'the row', pass, { verifies: true });
    await expect(
      steps.run(
        'assertion',
        'expect.toHaveText',
        'the row',
        async () => {
          throw new Error('mismatch');
        },
        { verifies: true },
      ),
    ).rejects.toThrow('mismatch');
    expect(steps.lastVerifiedStepIndex).toBe(0);
  });
});

describe('async step ownership', () => {
  it('attributes overlapping siblings and nested work to their own scopes', async () => {
    const steps = new StepRecorder('attempt');
    const firstGate = deferred();
    const secondGate = deferred();
    const first = steps.run('resource', 'first', '', async () => {
      await firstGate.promise;
      steps.attachArtifact('first');
    });
    const second = steps.run('resource', 'second', '', async () => {
      await secondGate.promise;
      expect(steps.currentStepId).toBe('attempt:1');
      await steps.run('resource', 'nested', '', async () => { steps.attachArtifact('nested'); });
      steps.attachArtifact('second');
    });
    firstGate.resolve();
    await first;
    expect(steps.currentStepId).toBeUndefined();
    secondGate.resolve();
    await second;
    expect(steps.currentStepId).toBeUndefined();
    expect(steps.all().map((step) => step.artifacts)).toEqual([['first'], ['second'], ['nested']]);
  });

  it('ignores late work inherited from a completed step instead of attaching it to a newer step', async () => {
    const steps = new StepRecorder('attempt');
    const lateGate = deferred();
    let late: Promise<void> | undefined;
    await steps.run('resource', 'finished', '', async () => {
      late = lateGate.promise.then(() => {
        steps.attachArtifact('late');
        steps.attachViewport({ width: 1, height: 1, scale: 1 });
        steps.recordEvent({ kind: 'backend', startedAt: '', durationMs: 0, status: 'passed' });
      });
    });
    await steps.run('resource', 'newer', '', async () => { lateGate.resolve(); await late; });
    for (const step of steps.all()) {
      expect(step.artifacts).toEqual([]);
      expect(step.events).toEqual([]);
      expect(step.viewport).toBeUndefined();
    }
  });
});

/** A gate for controlling completion order without relying on timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
