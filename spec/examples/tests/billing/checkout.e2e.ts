import { test, expect } from 'e2e';

/**
 * Both tiers in one test — the expected authoring style, not a smell:
 * screen where the path is stable, act() where the flow is genuinely
 * dynamic. Every call below is its own step in the report timeline — no
 * wrapper ceremony.
 */
test('member upgrades to the Pro plan', { tags: ['billing', 'smoke'], session: 'member' }, async ({ app, agent, screen }) => {
  await app.open('/settings/billing');
  await screen.getByRole('button', { name: 'Upgrade' }).tap();      // deterministic

  // agentic: the plan picker and the iframe-hosted payment form are a
  // frequently-changing provider UI — exactly where planning beats selectors.
  await agent.act('choose the Pro plan and complete the payment with the test card 4242 4242 4242 4242');

  await agent.assert('the billing page shows the Pro plan as active');
  await expect(screen.getByRole('status')).toContainText('Pro');
});
