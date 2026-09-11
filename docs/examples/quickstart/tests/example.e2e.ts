import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('app opens', async ({ app, web }) => {
  await app.open('/');
  await expect(web.locator('body')).toBeVisible();
});

// Runs once the key the model in e2e.config.ts reads is in the environment:
// test('the agent drives a flow', async ({ app, agent }) => {
//   await app.open('/');
//   await agent.act('one goal in plain language');
//   await agent.assert('one question about the screen');
// });
