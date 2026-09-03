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
