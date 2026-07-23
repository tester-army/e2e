import { test, credentials } from 'e2e';

/**
 * Setup tests run first, once per run (per target), and produce sessions.
 * Hundreds of tests start authenticated via `session: 'member'` instead of
 * repeating login. If a setup test fails, dependents are skipped with this
 * failure as the cause — not reported as their own failures.
 */

export const memberSession = test.setup('authenticate as member', async ({ agent, session }) => {
  await agent.login(credentials.user('member'));
  await session.save('member');
});

export const adminSession = test.setup('authenticate as admin', async ({ agent, session }) => {
  await agent.login(credentials.user('admin'));
  await session.save('admin');
});
