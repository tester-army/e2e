import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';

/** Taps the pad tiles in order; each is a bare div, so its text is the only handle. */
async function tapTiles(screen: Screen, tiles: string): Promise<void> {
  for (const tile of tiles) {
    await screen.getByText(tile).tap();
  }
}

test.describe('div soup', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/div-soup');
  });

  test('a wrong code is rejected', async ({ screen }) => {
    await tapTiles(screen, '1234→');
    await expect(screen.getByText('Wrong code')).toBeVisible();
  });

  test('the right code grants access after the delete tile fixes a typo', async ({ screen }) => {
    await tapTiles(screen, '728‹91→');
    await expect(screen.getByText('Access granted')).toBeVisible();
  });
});
