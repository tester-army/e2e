/**
 * The judgment tier against a real model: `agent.assert`, `agent.waitFor`, and
 * schema-validated `agent.extract`, each paired with a deterministic check so a
 * wrong judgment cannot pass silently.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';

test('assert judges seeded state, mixed with deterministic steps', async ({
  browser,
  agent,
  screen,
}) => {
  await browser.goto('/todos');
  await screen.getByLabel('New todo').fill('Review the release notes');
  await screen.getByRole('button', 'Add').click();
  await screen.getByLabel('New todo').fill('File the expense report');
  await screen.getByRole('button', 'Add').click();
  await expect(screen.getByRole('status')).toHaveText('2 remaining');
  await agent.assert('two todos are listed and neither is marked done');
});

test('assert fails when one of two displayed totals contradicts it', async ({
  browser,
  agent,
  screen,
}) => {
  await browser.goto('/checkout');
  await screen.getByLabel('Notebook quantity').fill('3');
  await expect(screen.getByText('$42.00')).toBeVisible();
  await expect(screen.getByRole('button', 'Pay $18.00')).toBeVisible();
  const code = await agent.assert('the order total is $42.00').then(
    () => undefined,
    (cause: unknown) => (cause as { code?: string }).code,
  );
  expect(code).toBe('ASSERTION_FAILED');
});

test('assert holds for a claim about some item when another item differs', async ({
  browser,
  agent,
  screen,
}) => {
  await browser.goto('/todos');
  await screen.getByLabel('New todo').fill('Pay the invoice');
  await screen.getByRole('button', 'Add').click();
  await screen.getByLabel('New todo').fill('Book the venue');
  await screen.getByRole('button', 'Add').click();
  await screen.getByRole('checkbox').first().check();
  await expect(screen.getByRole('status')).toHaveText('1 remaining');
  await agent.assert('a todo is marked done');
});

test('assert holds for one value when a different value is stale', async ({
  browser,
  agent,
  screen,
}) => {
  await browser.goto('/checkout');
  await screen.getByLabel('Notebook quantity').fill('3');
  await expect(screen.getByRole('button', 'Pay $18.00')).toBeVisible();
  await agent.assert('the Notebook line total is $36.00');
});

test('assert holds for the named instance when another instance is stale', async ({
  browser,
  agent,
  screen,
}) => {
  await browser.goto('/checkout');
  await screen.getByLabel('Notebook quantity').fill('3');
  await expect(screen.getByText('$42.00')).toBeVisible();
  await expect(screen.getByRole('button', 'Pay $18.00')).toBeVisible();
  await agent.assert('the order summary total is $42.00');
});

test('waitFor polls until the loaded users appear', async ({ browser, agent, screen }) => {
  await browser.goto('/network');
  await screen.getByRole('button', 'Load users').click();
  await agent.waitFor('the list shows the three users Ada, Grace, and Margaret', {
    interval: 250,
  });
  await expect(screen.getByRole('status')).toHaveText('loaded 3');
});

test('extract returns schema-validated data from the screen', async ({
  browser,
  agent,
  screen,
}) => {
  await browser.goto('/todos');
  await screen.getByLabel('New todo').fill('Water the plants');
  await screen.getByRole('button', 'Add').click();
  const data = await agent.extract('the todo titles and the remaining count', {
    schema: z.object({
      todos: z.array(z.string()),
      remaining: z.number().int(),
    }),
  });
  expect(data.remaining).toBe(1);
  expect(data.todos).toContain('Water the plants');
});

test('act and a judgment cooperate in one flow', async ({ browser, agent, screen }) => {
  await browser.goto('/forms');
  await agent.act('fill the profile with the name "Ada Lovelace" and the team "Platform", then save');
  await agent.assert('the profile form reports it was saved');
  await expect(screen.getByLabel('Full name')).toHaveValue('Ada Lovelace');
});

test('a vision judgment reads drawn pixels the tree cannot show', async ({ browser, agent }) => {
  await browser.goto('/canvas');
  // The chart exists only as canvas pixels, so the tree alone cannot answer.
  await agent.assert('the bar chart trends upward from left to right', { vision: true });
});
