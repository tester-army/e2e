/**
 * `agent.act()` against a real model: multi-action flows planned and executed
 * by the default ToolLoopAgent executor, verified deterministically after.
 */

import { test, expect } from 'e2e';

test('act drives a multi-action todo flow', async ({ web, agent, screen }) => {
  await web.goto('/todos');
  await agent.act('add two todos named "Buy milk" and "Walk the dog", then mark "Buy milk" as done');
  await expect(screen.getByRole('status')).toHaveText('1 remaining');
  await expect(screen.getByText('Buy milk')).toBeVisible();
  await expect(screen.getByText('Walk the dog')).toBeVisible();
});

test('act completes the workspace wizard end to end', async ({ web, agent, screen }) => {
  await web.goto('/wizard');
  await agent.act('create a workspace named "Atlas" on the Pro plan by walking through the wizard');
  await expect(screen.getByRole('status')).toHaveText('Created "Atlas" on the Pro plan');
});

test('act signs in with parameters', async ({ web, agent, screen }) => {
  await web.goto('/login');
  await agent.act('sign in with the given credentials', {
    username: 'admin',
    password: 'admin-pass',
  });
  await expect(screen.getByRole('status')).toHaveText('Welcome back, admin!');
});
