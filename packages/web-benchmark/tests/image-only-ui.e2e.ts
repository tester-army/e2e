import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Locator } from 'e2e';

/** The center of a node's box, the point a pixel-driven user would aim for. */
async function centerOf(node: Locator): Promise<{ x: number; y: number }> {
  const box = await node.boundingBox();
  if (box === null) throw new Error('node has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Every label is a PNG and the buttons are unnamed inline SVGs, so the
// web-only CSS locator is the one handle the DOM offers: bolt, star, heart in
// document order. Success unmounts the icon row and swaps the instruction
// image for the success image, which is what the assertions read.
test.describe('image only ui', () => {
  test.beforeEach(async ({ app, web }) => {
    await app.open('/e/image-only-ui');
    await expect(web.locator('svg')).toHaveCount(3);
  });

  test('a wrong icon shows the error image and keeps the icons', async ({ web }) => {
    await web.locator('svg').nth(0).tap();
    await expect(web.locator('img')).toHaveCount(2);
    await expect(web.locator('svg')).toHaveCount(3);
  });

  test('tapping the star, then the heart, verifies the icons', async ({ screen, web }) => {
    const icons = web.locator('svg');
    await screen.tapAt(await centerOf(icons.nth(1)));
    await screen.tapAt(await centerOf(icons.nth(2)));
    await expect(icons).toHaveCount(0);
    await expect(web.locator('img')).toHaveCount(1);
  });
});
