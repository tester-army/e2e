import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The swatches page draws solid blocks with no text, so each stored screenshot
// is the same file on every operating system the suite runs on.
test.describe('screenshots', { requires: ['browser'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/swatches');
  });

  test('compares a block with a changing part masked', async ({ screen }) => {
    await expect(screen.getByTestId('palette')).toHaveScreenshot('palette.png', { mask: [screen.getByTestId('noise')] });
  });

  test('scrolls a block below the fold into view before comparing it', async ({ screen }) => {
    await expect(screen.getByTestId('far')).toHaveScreenshot('far.png');
  });

  test('compares a block inside a frame', async ({ browser }) => {
    await expect(browser.frameLocator('#swatch-frame').getByTestId('framed')).toHaveScreenshot('framed.png');
  });

  test('tells one block from another\'s stored screenshot', async ({ screen }) => {
    await expect(screen.getByTestId('far')).not.toHaveScreenshot('palette.png');
  });
});
