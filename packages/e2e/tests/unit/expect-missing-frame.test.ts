import { afterEach, describe, expect as vexpect, it } from 'vitest';
import { EngineError, type SemanticNode } from '../../src/engine/index.ts';
import { expect } from '../../src/expect/index.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const pay: SemanticNode = { ref: { id: 'pay', revision: '' }, role: 'button', name: 'Pay', text: 'Pay' };

const timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
});

/** A screen whose every locate reports the frame missing until `frameAfterMs`, then finds `pay`. */
function closedFrame(frameAfterMs = Number.POSITIVE_INFINITY) {
  let frame = false;
  if (Number.isFinite(frameAfterMs)) timers.push(setTimeout(() => (frame = true), frameAfterMs));
  const { screen } = screenOver({
    locate: () => {
      if (!frame) throw new EngineError('FRAME_NOT_FOUND', 'no frame matches #checkout', { retryable: true });
      return [pay];
    },
    observe: () => snapshot([]),
    timeoutMs: 1_000,
  });
  return screen.getByRole('button');
}

describe('whole-set matchers on a missing frame', () => {
  it('read it as zero matches, as count() and toBeHidden do', async () => {
    const button = closedFrame();
    vexpect(await button.count()).toBe(0);
    await expect(button).toBeHidden();
    await expect(button).toHaveCount(0);
    await expect(button).not.toHaveCount(2);
    await expect(button).toHaveText([]);
    await expect(button).not.toContainText(['Pay']);
  });

  it('fail a positive count as a count mismatch, not a missing locator', async () => {
    await vexpect(expect(closedFrame()).toHaveCount(1, { timeout: 300 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: count 0'),
    });
  });

  it('fail a text list as a text mismatch, not a missing locator', async () => {
    await vexpect(expect(closedFrame()).toHaveText(['Pay'], { timeout: 300 })).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vexpect.stringContaining('observed: text []'),
    });
  });

  it('keep polling until the frame appears', async () => {
    const button = closedFrame(400);
    await expect(button).toHaveCount(1);
    await expect(button).toHaveText(['Pay']);
  });
});
