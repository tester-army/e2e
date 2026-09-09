import { test } from '@e2edev/agent-device';
import { expect } from '@e2edev/e2e';

test('Settings opens', async ({ screen }) => {
  await expect(screen.getByText('Network & internet')).toBeVisible();
});
