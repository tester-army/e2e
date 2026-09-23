import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';

/** The pad is bare divs with no roles or ids, so a tile's glyph is its only handle. */
async function tapTiles(screen: Screen, tiles: readonly string[]): Promise<void> {
  for (const tile of tiles) {
    await screen.getByText(tile).tap();
  }
}

test.describe('div soup', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/div-soup');
  });

  test('a wrong code is rejected', async ({ screen }) => {
    await tapTiles(screen, ['1', '2', '3', '4', '→']);
    await expect(screen.getByText('Wrong code')).toBeVisible();
  });

  test('the right code grants access after the delete tile fixes a typo', async ({ screen }) => {
    await tapTiles(screen, ['7', '2', '8', '‹', '9', '1', '→']);
    await expect(screen.getByText('Access granted')).toBeVisible();
  });
});
