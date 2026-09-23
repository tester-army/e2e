import { test } from '@e2edev/web';
import { expect } from 'e2e';

// The whole flow sits under one aria-hidden container of bare divs, so no
// role, label, or test id query can reach it; visible text is the only handle.
test.describe('aria hidden flow', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/aria-hidden-flow');
  });

  test('picks the Pro plan by its visible text and confirms it', async ({ screen }) => {
    await expect(screen.getByText('Choose the Pro plan')).toBeVisible();
    await screen.getByText('Pro').tap();
    await expect(screen.getByText('Pro plan - $29/mo')).toBeVisible();
    await screen.getByText('Confirm Pro plan').tap();
    await expect(screen.getByText('Plan activated')).toBeVisible();
  });

  test('another plan shows the error and keeps the picker open', async ({ screen }) => {
    await screen.getByText('Basic').tap();
    await expect(screen.getByText('That is not the Pro plan')).toBeVisible();
    await expect(screen.getByText('Choose the Pro plan')).toBeVisible();
  });
});
