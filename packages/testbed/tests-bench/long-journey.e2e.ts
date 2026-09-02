/**
 * Bench: a long CRUD journey — several dependent `agent.act` steps on one
 * page, each verified deterministically so a wrong model verdict cannot pass.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('drives a multi-step expense journey', async ({ web, agent, screen }) => {
  // Deterministic isolation: a retry or a leftover server must never start
  // from a dirty store — duplicates would break every text assertion below.
  await fetch('http://localhost:4273/api/reset', { method: 'POST' });
  await web.goto('/expenses');

  await agent.act(
    'add an expense titled "Taxi to airport" with amount 42 in the Travel category',
  );
  await expect(screen.getByText('Taxi to airport — $42.00 (Travel)')).toBeVisible();

  await agent.act('approve the "Taxi to airport" expense');
  await expect(screen.getByRole('button', { name: 'Unapprove Taxi to airport' })).toBeVisible();

  await agent.act('add another expense titled "Team lunch" with amount 18 in the Meals category');
  await expect(screen.getByText('Team lunch — $18.00 (Meals)')).toBeVisible();

  await agent.act('delete the "Conference flights" expense');
  await expect(screen.getByText('Conference flights — $320.00 (Travel)')).toBeHidden();
  await expect(screen.getByText('Taxi to airport — $42.00 (Travel)')).toBeVisible();
});
