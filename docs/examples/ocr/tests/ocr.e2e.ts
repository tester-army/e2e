import { test } from 'e2e';

test('continues through a drawn control', async ({ app, agent }) => {
  await app.open('/canvas');
  await agent.act('tap Continue');
  await agent.assert('Ready is visible');
});
