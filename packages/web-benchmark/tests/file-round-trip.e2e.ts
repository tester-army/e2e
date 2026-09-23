import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('file round trip', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/file-round-trip');
  });

  test('a different file is refused', async ({ screen }) => {
    await screen.getByTestId('upload-input').setInputFiles('fixtures/not-the-voucher.txt');
    await expect(screen.getByText('Selected file: not-the-voucher.txt')).toBeVisible();
    await expect(screen.getByTestId('error-message')).toHaveText(
      'That is not the voucher we issued',
    );
  });

  test('the downloaded voucher verifies when uploaded back', async ({ screen, web }) => {
    const download = await web.waitForDownload(() =>
      screen.getByRole('button', { name: 'Download voucher' }).tap(),
    );
    expect(download.suggestedFilename).toBe('voucher.txt');
    await expect(screen.getByTestId('download-status')).toHaveText('Voucher downloaded');
    await screen.getByTestId('upload-input').setInputFiles(download.absolutePath);
    await expect(screen.getByTestId('success-message')).toHaveText('Voucher verified');
  });
});
