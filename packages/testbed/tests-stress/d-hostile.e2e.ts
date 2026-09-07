import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('title with  bell, [31mANSI[0m, and a tab\tinside', async ({ app }) => {
  await app.open();
});

test(`very long title ${'x'.repeat(400)}`, async ({ app }) => {
  await app.open();
});

test('fails with a 20 KiB message', async ({ app }) => {
  await app.open();
  throw new Error(`huge: ${'y'.repeat(20_000)}`);
});

test.describe('nested suite', () => {
  test('fails inside a helper so the frame is deeper', async ({ app, screen }) => {
    await app.open();
    await assertMissing(screen);
  });
});

async function assertMissing(screen: {
  getByRole(role: 'heading', options: { name: string }): unknown;
}) {
  await expect(screen.getByRole('heading', { name: 'Nowhere' }) as never).toBeVisible({ timeout: 200 });
}
