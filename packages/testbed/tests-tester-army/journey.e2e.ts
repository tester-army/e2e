/**
 * A long read-only tour through tester.army: many dependent `agent.act`
 * steps across the marketing site, each anchored by a deterministic check so
 * a wrong model verdict cannot pass. With the trace cache on (the default),
 * the second run replays the whole tour zero-turn.
 *
 * No per-act timeouts: every driver operation inside a step is bounded by
 * `actionTimeout` (90s in this config), so a page that never settles costs
 * one bounded, attributed failure — never the test budget.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('tours the tester.army marketing site end to end', async ({ app, web, screen, agent }) => {
  await app.open();
  await expect(web).toHaveTitle(/TesterArmy/);
  await expect(screen.getByRole('heading', { name: /You ship/ })).toBeVisible();

  await agent.act('open the Pricing page from the header navigation');
  await expect(web).toHaveURL(/\/pricing/);

  await agent.act('open the Customers page from the header navigation');
  await expect(web).toHaveURL(/\/customers/);

  await agent.act('go to the web application testing solutions page at the path /solutions/web');
  await expect(web).toHaveURL(/\/solutions\/web/);
  await agent.assert('the page describes testing web applications with AI agents');

  await agent.act('go to the mobile testing solutions page at the path /solutions/mobile');
  await expect(web).toHaveURL(/\/solutions\/mobile/);

  await agent.act('go back to the home page using the site logo in the header');
  await expect(screen.getByRole('heading', { name: /You ship/ })).toBeVisible();

  await agent.act('open the sign-in page from the header');
  // Sign-in hands off to the hosted auth domain; the cross-domain redirect
  // chain needs more than the 5s assertion default. The auth form itself is
  // not part of the observed accessibility tree (it renders framed), so the
  // heading check is the honest anchor here.
  await expect(web).toHaveURL(/auth\.tester\.army|\/sign-in/, { timeout: 15_000 });
  await expect(screen.getByRole('heading', { name: /Sign in to TesterArmy/ })).toBeVisible();
});
