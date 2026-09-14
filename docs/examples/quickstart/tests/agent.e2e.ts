import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('a visitor signs up for a trial', async ({ app, agent, screen }) => {
  await app.open('/');

  await agent.act('sign up for a free trial as {name} with email {email}', {
    params: { name: 'Ada Lovelace', email: 'ada@example.test' },
  });

  await agent.assert('the welcome screen greets Ada by name');
  await expect(screen.getByRole('status')).toContainText('trial');
});
