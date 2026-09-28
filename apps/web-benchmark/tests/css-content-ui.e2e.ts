import { test } from '@e2e-dev/web';
import type { Web } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * Reads the `::before` text of the first node matching `selector`. The page
 * paints every label this way and the DOM holds no text, so no locator
 * matcher can read it; `expect.poll` over this read stands in for the CSS
 * content matcher the engine does not have.
 */
async function pseudoText(web: Web, selector: string): Promise<string> {
  return web.evaluate((css: string) => {
    const node = document.querySelector(css);
    if (node === null) throw new Error(`no node matches ${css}`);
    return getComputedStyle(node, '::before').content.replace(/^"|"$/g, '');
  }, selector);
}

test.describe('css content ui', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/css-content-ui');
  });

  test('the tile labelled Ship it advances and confirming ships', async ({ web }) => {
    await expect.poll(() => pseudoText(web, '.wb-css-instruction')).toBe('Press Ship it, then confirm');
    await expect.poll(() => pseudoText(web, '.wb-css-action-b')).toBe('Ship it');

    await web.locator('.wb-css-action-b').tap();
    await expect.poll(() => pseudoText(web, '.wb-css-confirm')).toBe('Confirm ship');

    await web.locator('.wb-css-confirm').tap();
    await expect.poll(() => pseudoText(web, '.wb-css-success')).toBe('Shipped successfully');
  });

  test('a wrong tile shows the CSS-rendered error and keeps the picker', async ({ web }) => {
    await web.locator('.wb-css-action-a').tap();
    await expect.poll(() => pseudoText(web, '.wb-css-error')).toBe('Wrong action');
    await expect(web.locator('.wb-css-action-b')).toBeVisible();
  });
});
