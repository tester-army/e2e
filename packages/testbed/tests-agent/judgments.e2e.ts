/**
 * The judgment tier against a real model: `agent.assert`, `agent.waitFor`, and
 * schema-validated `agent.extract`, each paired with a deterministic check so a
 * wrong judgment cannot pass silently.
 */

import { test, expect } from 'e2e';
import { z } from 'zod';

test('assert judges seeded state, mixed with deterministic steps', async ({
  web,
  agent,
  screen,
}) => {
  await web.goto('/todos');
  await screen.getByLabel('New todo').fill('Review the release notes');
  await screen.getByRole('button', { name: 'Add' }).click();
  await screen.getByLabel('New todo').fill('File the expense report');
  await screen.getByRole('button', { name: 'Add' }).click();
  await expect(screen.getByRole('status')).toHaveText('2 remaining');
  await agent.assert('two todos are listed and neither is marked done');
});

test('waitFor polls until the loaded users appear', async ({ web, agent, screen }) => {
  await web.goto('/network');
  await screen.getByRole('button', { name: 'Load users' }).click();
  await agent.waitFor('the list shows the three users Ada, Grace, and Margaret', {
    intervalMs: 250,
  });
  await expect(screen.getByRole('status')).toHaveText('loaded 3');
});

test('extract returns schema-validated data from the screen', async ({
  web,
  agent,
  screen,
}) => {
  await web.goto('/todos');
  await screen.getByLabel('New todo').fill('Water the plants');
  await screen.getByRole('button', { name: 'Add' }).click();
  const data = await agent.extract('the todo titles and the remaining count', {
    schema: z.object({
      todos: z.array(z.string()),
      remaining: z.number().int(),
    }),
  });
  expect(data.remaining).toBe(1);
  expect(data.todos).toContain('Water the plants');
});

test('act and a judgment cooperate in one flow', async ({ web, agent, screen }) => {
  await web.goto('/forms');
  await agent.act('fill the profile with the name "Ada Lovelace" and the team "Platform", then save');
  await agent.assert('the profile form reports it was saved');
  await expect(screen.getByLabel('Full name')).toHaveValue('Ada Lovelace');
});

test('a vision judgment reads drawn pixels the tree cannot show', async ({ web, agent }) => {
  await web.goto('/canvas');
  // The chart exists only as canvas pixels, so the tree alone cannot answer.
  await agent.assert('the bar chart trends upward from left to right', { vision: true });
});
