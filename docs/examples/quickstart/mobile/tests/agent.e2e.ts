import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('the agent opens General', async ({ agent, app, device }) => {
  await app.open();
  await agent.act('open {section} settings', { params: { section: 'General' } });

  await agent.assert('the General settings screen is showing');
  await expect(device.locator('role=navigation-bar id=General')).toBeVisible();
});
