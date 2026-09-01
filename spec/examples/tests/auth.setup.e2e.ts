import { test, credentials } from 'e2e';

/**
 * Setup tests run first once per selected target and produce declared sessions.
 * Hundreds of tests start authenticated via `session: 'member'` instead of
 * repeating sign-in. If a setup test fails, dependents are skipped with this
 * failure as the cause — not reported as their own failures.
 *
 * The password stays an opaque Secret: the model sees only its name and
 * purpose, and the fill runs through the authorized secure input sink.
 */

test.setup('authenticate as member', { sessions: ['member'] }, async ({ app, agent, session }) => {
  await app.open();
  const member = credentials.user('member');
  await agent.act('Sign in', { user: member.username, password: member.password });
  await session.save('member');
});

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, agent, session }) => {
  await app.open();
  const admin = credentials.user('admin');
  await agent.act('Sign in', { user: admin.username, password: admin.password });
  await session.save('admin');
});
