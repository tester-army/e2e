import { test, expect } from 'e2e';

/**
 * All three tiers in one test — the expected authoring style, not a smell:
 * screen where the path is stable, instant actions where NL targets beat
 * selectors, act() where the flow is genuinely dynamic. Every call below
 * is its own step in the report timeline — no wrapper ceremony.
 */
export default test('member upgrades to the Pro plan', { tags: ['billing', 'smoke'], session: 'member' }, async ({ app, agent, screen }) => {
  await app.open('/settings/billing');
  await screen.getByRole('button', { name: 'Upgrade' }).tap();      // tier 3: deterministic
  await agent.tap('the Pro plan card');                             // tier 2: AI locates, cached

  // tier 1: the payment form is an iframe-hosted, frequently-changing
  // provider UI — exactly where planning beats selectors.
  await agent.act('complete the payment with the test card 4242 4242 4242 4242');

  await agent.assert('the billing page shows the Pro plan as active');
  await expect(screen.getByRole('status')).toContainText('Pro');
});
