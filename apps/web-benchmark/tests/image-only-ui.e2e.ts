import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { failure } from './support.ts';

// Every label is a PNG and the buttons are unnamed inline SVGs, so the
// web-only CSS locator is the one handle the DOM offers: bolt, star, heart in
// document order.
test.describe('image only ui', () => {
  test.beforeEach(async ({ app, browser }) => {
    await app.open('/e/image-only-ui');
    await expect(browser.locator('svg')).toHaveCount(3);
  });

  test('the icons have no names, so the bare svg locator is ambiguous', async ({ browser }) => {
    expect(await failure(() => browser.locator('svg').tap())).toHaveProperty('code', 'LOCATOR_AMBIGUOUS');
  });

  test('a wrong icon shows the error image and keeps the icons', async ({ browser }) => {
    await browser.locator('svg').nth(0).tap();
    await expect(browser.locator('img')).toHaveCount(2);
    await expect(browser.locator('svg')).toHaveCount(3);
  });

  test('tapping the star, then the heart, verifies the icons', async ({ browser }) => {
    const icons = browser.locator('svg');
    await icons.nth(1).tap();
    await icons.nth(2).tap();
    await expect(icons).toHaveCount(0);
    await expect(browser.locator('img')).toHaveCount(1);
  });
});
