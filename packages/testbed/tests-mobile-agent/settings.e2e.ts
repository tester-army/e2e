import { expect, test } from 'e2e';

test('agent taps a settings row it was described', async ({ app, agent, screen }) => {
  await app.open();

  await agent.tap('the General row in the settings list');
  await expect(screen.getByText('About')).toBeVisible();
});

test('agent judges the screen', async ({ app, agent }) => {
  await app.open();

  await agent.assert('the settings list is showing');
});
