/**
 * A long read-only tour through tester.army: many dependent `agent.act`
 * steps across the marketing site, each anchored by a deterministic check so
 * a wrong model verdict cannot pass. With the trace cache on (the default),
 * the second run replays the whole tour zero-turn.
 *
 * Every act carries its own timeout: on a production site a single page that
 * never settles must cost two minutes and a clear step failure, not the whole
 * test budget.
 */

import { test, expect } from 'e2e';

const ACT = { timeout: 120_000 };

test('tours the tester.army marketing site end to end', async ({ app, web, screen, agent }) => {
  await app.open();
  await expect(web).toHaveTitle(/TesterArmy/);
  await expect(screen.getByRole('heading', { name: /You ship/ })).toBeVisible();

  await agent.act('open the Pricing page from the header navigation', undefined, ACT);
  await expect(web).toHaveURL(/\/pricing/);

  await agent.act('open the Customers page from the header navigation', undefined, ACT);
  await expect(web).toHaveURL(/\/customers/);

  await agent.act(
    'go to the web application testing solutions page at the path /solutions/web',
    undefined,
    ACT,
  );
  await expect(web).toHaveURL(/\/solutions\/web/);
  await agent.assert('the page describes testing web applications with AI agents', {
    timeout: 60_000,
  });

  await agent.act(
    'go to the mobile testing solutions page at the path /solutions/mobile',
    undefined,
    ACT,
  );
  await expect(web).toHaveURL(/\/solutions\/mobile/);

  await agent.act('go back to the home page using the site logo in the header', undefined, ACT);
  await expect(screen.getByRole('heading', { name: /You ship/ })).toBeVisible();

  await agent.act('open the sign-in page from the header', undefined, ACT);
  // Sign-in hands off to the hosted auth domain. The auth form itself is not
  // part of the observed accessibility tree (it renders framed), so the
  // deterministic heading check is the honest anchor here.
  await expect(web).toHaveURL(/auth\.tester\.army|\/sign-in/, { timeout: 15_000 });
  await expect(screen.getByRole('heading', { name: /Sign in to TesterArmy/ })).toBeVisible();
});
