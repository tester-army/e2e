/**
 * Hostile flows: the shapes that made real customer runs fail or flake,
 * reproduced deterministically. Half of these must PASS despite the hostility
 * (the runner has to wait, dismiss, retry, and pick the right control); the
 * rest must fail HONESTLY — a wrong-page save, a request that never returns —
 * within their budget, with the right code, and without a false pass.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

async function reset(): Promise<void> {
  await fetch('http://localhost:4273/api/reset', { method: 'POST' });
}

test('deletes behind a consent banner and waits for an eventually consistent list', async ({ web, agent, screen }) => {
  await reset();
  await web.goto('/hostile/library');

  // The toolbar is under a fixed consent banner; two "Quarterly report" rows differ only by folder.
  await agent.act('Accept the cookie banner, then delete the "Budget draft" document in the Finance folder.');
  // The list reflects the delete four seconds later; the deterministic check waits.
  await expect(screen.getByText('Budget draft')).toBeHidden({ timeout: 15_000 });
  await expect(screen.getByText('Finance: 2 item(s)')).toBeVisible({ timeout: 15_000 });
});

test('moves a document and verifies in the destination folder despite the lag', async ({ web, agent, screen }) => {
  await reset();
  await web.goto('/hostile/library');
  await agent.act('Accept the cookie banner. Then move "Vendor list" from the Ops folder to the Archive folder.');
  await agent.act('Show the Archive folder and confirm "Vendor list" is listed there. It may take a few seconds to appear; wait for it.');
  await expect(screen.getByText('Archive: 1 item(s)')).toBeVisible({ timeout: 15_000 });
});

test('retries a save that fails once and waits for async validation', async ({ web, agent, screen }) => {
  await reset();
  await web.goto('/hostile/notes');
  await agent.act('Save the note "Renew the vendor contract". If saving fails, try again until the note is saved.');
  await expect(screen.getByRole('status', { name: 'Saved note' })).toHaveText('Saved note: Renew the vendor contract');
});

test('waits out a slow report', async ({ web, agent, screen }) => {
  await web.goto('/hostile/report');
  await agent.act('Generate the report and wait until it is ready.');
  await expect(screen.getByRole('status', { name: 'Report status' })).toHaveText('Report ready: 12 rows exported');
});

test('waits out a much slower report instead of giving up', async ({ web, agent, screen }) => {
  await web.goto('/hostile/report');
  await agent.act('Generate the annual report and wait until it is ready; it can take half a minute.');
  await expect(screen.getByRole('status', { name: 'Annual report status' })).toHaveText('Annual report ready: 480 rows exported');
});

test('saves the name in the right workspace tab', async ({ web, agent, screen }) => {
  await web.goto('/hostile/tabs');
  await agent.act('Rename the Sales workspace to "Revenue".');
  await agent.act('Open the Sales workspace tab.');
  await expect(screen.getByRole('status', { name: 'Current name' })).toHaveText('Current name: Revenue');
  await agent.act('Open the Design workspace tab.');
  await expect(screen.getByRole('status', { name: 'Current name' })).toHaveText('Current name: Design');
});

test('types into self-formatting payment fields without losing characters', async ({ web, agent, screen }) => {
  await web.goto('/hostile/payment');
  await agent.act('Pay with the given card.', {
    cardNumber: '4242424242424242',
    expiry: '12/29',
    nameOnCard: 'alex bench',
  });
  await expect(screen.getByRole('status', { name: 'Payment result' })).toHaveText(
    'Payment of €44.95 completed for Alex Bench (card ending 4242)',
  );
});

test('gives up honestly on a sync that never completes', async ({ web, agent, screen }) => {
  await web.goto('/hostile/report');
  let outcome = 'passed';
  let code: string | undefined;
  let blocked: boolean | undefined;
  const startedMs = Date.now();
  try {
    await agent.act('Sync with the ERP and confirm the sync finished.', undefined, { timeout: 90_000, maxSteps: 8 });
  } catch (error) {
    const failure = error as { code?: string; blocked?: boolean };
    outcome = 'failed';
    code = failure.code;
    blocked = failure.blocked;
  }
  const elapsedMs = Date.now() - startedMs;
  // Never a false pass: the sync cannot finish.
  expect(outcome).toBe('failed');
  // Concluded by the agent or cut by the clock, but well inside the budget and the wind-down.
  expect(['ACTION_FAILED', 'ASSERTION_FAILED', 'STEP_TIMEOUT', 'STEP_BUDGET_EXHAUSTED', 'ENVIRONMENT_UNAVAILABLE'].includes(code ?? '')).toBe(true);
  expect(elapsedMs < 95_000).toBe(true);
  void blocked;
  await expect(screen.getByRole('status', { name: 'Sync status' })).toHaveText('Syncing… this may take a moment');
});
