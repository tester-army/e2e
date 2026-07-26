import { credentials, test, expect } from 'e2e';

/**
 * Dogfoods host-side secret handling: the model only ever sees the field it
 * selected, never the credential value, and the viewport becomes pixel-tainted
 * for the rest of the attempt once a secret is filled.
 */
test('the agent signs in with an opaque credential', async ({ app, agent, screen, web }) => {
  const admin = credentials.user('admin');

  await app.open('/login');
  await agent.type('the Username field', admin.username);
  await agent.type('the Password field', admin.password);
  await agent.tap('the Sign in button');

  await expect(web).toHaveURL('/dashboard');
  await expect(screen.getByRole('status')).toContainText('Welcome back, admin!');
  await agent.assert('the page shows a dashboard for a signed-in user');
});

test('a rejected sign-in stays on the login page', async ({ app, agent, screen }) => {
  await app.open('/login');

  await agent.type('the Username field', 'admin');
  await agent.type('the Password field', 'wrong-password');
  await agent.tap('the Sign in button');

  await expect(screen.getByRole('alert')).toHaveText('Invalid credentials');
  await agent.assert('the page reports that the credentials were invalid');
});
