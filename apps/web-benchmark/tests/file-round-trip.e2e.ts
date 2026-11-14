import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/** The deterministic twin of the `file-round-trip` scenario: the voucher the page issues comes back verified. */
test.describe('file round trip', () => {
  test('downloads the issued voucher and verifies the same file uploaded back', async ({ app, screen, browser }) => {
    await app.open('/e/file-round-trip');
    const download = await browser.waitForDownload(() => screen.getByTestId('download-button').tap());
    expect(download.suggestedFilename).toBe('voucher.txt');
    expect(readFileSync(download.absolutePath, 'utf8')).toBe('VOUCHER:WEB-5521');
    await expect(screen.getByTestId('download-status')).toHaveText('Voucher downloaded');

    await screen.getByTestId('upload-input').setInputFiles(download.absolutePath);
    await expect(screen.getByTestId('success-message')).toHaveText('Voucher verified');
  });

  test('rejects a file that is not the voucher we issued', async ({ app, screen }) => {
    await app.open('/e/file-round-trip');
    await screen.getByTestId('upload-input').setInputFiles('fixtures/not-the-voucher.txt');
    await expect(screen.getByTestId('error-message')).toHaveText('That is not the voucher we issued');
    await expect(screen.getByTestId('success-message')).toHaveCount(0);
  });
});
