import { test } from '@e2e-dev/mobile';

test('continues through a drawn mobile control', async ({ app, agent }) => {
  await app.open();
  await agent.act('tap Continue');
  await agent.assert('Ready is visible');
});
