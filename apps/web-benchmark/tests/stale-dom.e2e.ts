import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator } from 'e2e';

/**
 * Waits for the next rebuild: every generation remounts the rows and rotates
 * the order by one slot, so the target's box moves once a second.
 */
async function waitForRebuild(target: Locator): Promise<void> {
  const before = (await target.boundingBox())?.y;
  await expect
    .poll(async () => (await target.boundingBox())?.y, { timeout: 5000 })
    .not.toBe(before);
}

test('taps the moving target three times across rebuilds of the list', async ({ app, screen }) => {
  await app.open('/e/stale-dom');
  const target = screen.getByRole('button', 'Tap me');
  const progress = screen.getByTestId('progress');
  await expect(progress).toHaveText('Progress: 0 / 3');
  await expect(screen.getByRole('button', 'Decoy')).toHaveCount(5);

  await target.tap();
  await expect(progress).toHaveText('Progress: 1 / 3');
  await waitForRebuild(target);
  await target.tap();
  await expect(progress).toHaveText('Progress: 2 / 3');
  await waitForRebuild(target);
  await target.tap();

  await expect(screen.getByTestId('success-message')).toHaveText('Target clicked 3 times');
  await expect(screen.getByTestId('error-message')).toBeHidden();
  await expect(target).toBeHidden();
});
