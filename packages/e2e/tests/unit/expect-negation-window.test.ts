/**
 * Negated matchers over a screen that changes while they poll: a negation
 * that begins late in the budget finishes its window past the deadline, a
 * short `{ timeout }` keeps half of itself for the negation to begin, a
 * one-poll flicker still fails, and a negation that begins after the
 * deadline fails saying how long it held.
 */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { sleep } from '../../src/internal/time.ts';
import { createScreenFixture, SCREEN_FIXTURE_TIMEOUT_MS } from '../helpers/screen-fixture.ts';

const TOAST: SemanticNode = { ref: { id: 'toast', revision: '' }, role: 'status', text: 'Saved' };

/**
 * A `status` locator over a screen that shows the toast, then swaps its node
 * list at each scheduled moment; `readMs` makes every engine read take that
 * long, like a slow device.
 */
function toastLocator(
  schedule: ReadonlyArray<readonly [atMs: number, nodes: readonly SemanticNode[]]>,
  readMs = 0,
) {
  let nodes: readonly SemanticNode[] = [TOAST];
  for (const [atMs, next] of schedule) {
    setTimeout(() => {
      nodes = next;
    }, atMs).unref();
  }
  return createScreenFixture(async () => {
    if (readMs > 0) await sleep(readMs);
    return nodes;
  }).getByRole('status');
}

describe('negated matchers over a changing screen', () => {
  it('passes when the negation begins at 60% of the budget, finishing its window past the deadline', async () => {
    const startedAt = Date.now();
    await expectFixture(toastLocator([[SCREEN_FIXTURE_TIMEOUT_MS * 0.6, []]])).not.toBeAttached();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SCREEN_FIXTURE_TIMEOUT_MS);
  });

  it('passes not.toBeVisible({ timeout: 800 }) when the node goes away at 200 ms', async () => {
    const startedAt = Date.now();
    await expectFixture(toastLocator([[200, []]])).not.toBeVisible({ timeout: 800 });
    expect(Date.now() - startedAt).toBeLessThan(800);
  });

  it('fails when the node is gone for one poll and back for the next', async () => {
    await expect(
      expectFixture(toastLocator([[120, []], [220, [TOAST]]])).not.toBeAttached(),
    ).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringMatching(/expected: not attached\nobserved: attached \(match count 1\)$/),
    });
  });

  it('says how long the negation held when it began after the deadline', async () => {
    await expect(
      expectFixture(toastLocator([[1000, []]], 200)).not.toBeAttached({ timeout: 900 }),
    ).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringMatching(
        /expected: not attached\nobserved: no node \(match count 0\)\nheld for \d+ ms, short of the 450 ms negation window$/,
      ),
    });
  });
});
