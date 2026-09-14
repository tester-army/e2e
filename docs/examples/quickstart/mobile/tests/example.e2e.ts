import { test } from '@e2edev/agent-device';
import { expect } from 'e2e';

test('Settings opens', async ({ screen }) => {
  await expect(screen.getByRole('button', { name: 'General' })).toBeVisible();
});

// With the model key in the environment, uncomment:
// test('the agent opens General', async ({ agent, device }) => {
//   await agent.act('open General settings');
//   await expect(device.locator('role=NavigationBar id=General')).toBeVisible();
// });
