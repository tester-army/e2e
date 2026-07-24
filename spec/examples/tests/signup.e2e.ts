import { test, expect } from 'e2e';

/**
 * The canonical happy path: a pure agentic flow. Its source is portable;
 * v0 executes it on web. Signup flows gated on email verification use a
 * future `email` resource extension.
 */
test('user can sign up', { tags: ['smoke', 'auth'] }, async ({ app, agent, screen }) => {
  await app.open();

  await agent.act('sign up as a new user named Ada Lovelace');

  await agent.assert('the user is signed in and sees an empty workspace');

  await expect(screen.getByRole('heading', { name: /welcome/i })).toBeVisible();
});
