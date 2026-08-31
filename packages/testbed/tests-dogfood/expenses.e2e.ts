/**
 * Dogfood: `agent.act()` against the expense-claims app. Every planned flow is
 * verified deterministically afterwards, so a wrong model verdict cannot pass.
 */

import { test, expect } from 'e2e';

test('files an expense and waits out the async save', async ({ web, agent, screen }) => {
  await web.goto('/');
  await agent.act(
    'reset all expenses using the reset_expenses tool, reload the page, then file an expense ' +
      '"Team lunch" of 42.50 in the Meals category and wait until the app confirms it saved',
  );
  await expect(screen.getByText('Team lunch — $42.50 (Meals)')).toBeVisible();
  await expect(screen.getByRole('status', { name: 'Total' })).toHaveText('Total: $42.50');
});

test('recovers from client-side validation', async ({ web, agent, screen }) => {
  await web.goto('/');
  await agent.act(
    'reset all expenses and reload, then try to file an expense with description "Taxi" and ' +
      'amount -8. The form will reject it; read the error, correct the amount to 8, and submit ' +
      'until it saves.',
  );
  await expect(screen.getByText('Taxi — $8.00 (Meals)')).toBeVisible();
});

test('seeds data with a project tool and deletes through the confirm modal', async ({
  web,
  agent,
  screen,
}) => {
  await web.goto('/');
  await agent.act(
    'reset all expenses, seed exactly 2 expenses with the seed_expenses tool, reload the page, ' +
      'then delete "Seeded expense 1" and confirm the deletion in the dialog',
  );
  await expect(screen.getByText('Seeded expense 2 — $20.00 (Travel)')).toBeVisible();
  await expect(screen.getByRole('status', { name: 'Total' })).toHaveText('Total: $20.00');
});

test('filters with the category select', async ({ web, agent, screen }) => {
  await web.goto('/');
  await agent.act(
    'reset all expenses, seed exactly 4 expenses, reload, then set the filter so only Travel ' +
      'expenses are listed',
  );
  await expect(screen.getByText('Seeded expense 2 — $20.00 (Travel)')).toBeVisible();
  await expect(screen.getByText('Seeded expense 1 — $10.00 (Meals)')).toBeHidden();
  await expect(screen.getByRole('status', { name: 'Total' })).toHaveText('Total: $60.00');
});
