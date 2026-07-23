import { test, expect, email } from 'e2e';

/**
 * The canonical happy path: agentic flow + email resource. Runs unchanged
 * on web, iOS, and Android — nothing here is platform-specific.
 */
export default test('user can sign up with email verification', { tags: ['smoke', 'auth'] }, async ({ app, agent }) => {
  const inbox = email.inbox('signup');

  await app.open();

  await agent.act('create an account using this email', {
    email: inbox.address,
    fullName: 'Ada Lovelace',
  });

  const code = await inbox.code({ from: 'noreply@orbit.test' });

  await agent.act('enter the verification code', { code });

  await agent.assert('the user is signed in and sees an empty workspace');

  // Resource matcher: the welcome email also arrived.
  await expect(inbox).toHaveEmail({ subject: /welcome to orbit/i });
});
