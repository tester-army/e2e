import { test, credentials } from 'e2e';

/**
 * Setup tests run first once per selected target and produce declared sessions.
 * Hundreds of tests start authenticated via `session: 'member'` instead of
 * repeating login. If a setup test fails, dependents are skipped with this
 * failure as the cause — not reported as their own failures.
 */

test.setup('authenticate as member', { sessions: ['member'] }, async ({ app, agent, session }) => {
  await app.open();
  await agent.login(credentials.user('member'));
  await session.save('member');
});

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, agent, session }) => {
  await app.open();
  await agent.login(credentials.user('admin'));
  await session.save('admin');
});
