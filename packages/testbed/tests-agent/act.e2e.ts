/**
 * `agent.act()` against a real model: multi-action flows planned and executed
 * by the default ToolLoopAgent executor, verified deterministically after.
 */

import { test } from '@e2edev/playwright';
import { expect, credentials } from 'e2e';

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

test('act signs in with a secret credential', async ({ web, agent, screen }) => {
  await web.goto('/login');
  // The password is a Secret: the model sees only its name and purpose, and
  // the fill runs through the authorized type_secret tool.
  await agent.act('sign in with the given credentials', {
    params: { username: 'admin', password: credentials.user('admin').password },
  });
  await expect(screen.getByRole('status')).toHaveText('Welcome back, admin!');
});

test('act taps a pin painted on a canvas through the pixel tier', async ({ web, agent, screen }) => {
  await web.goto('/canvas');
  // The pins exist only as canvas pixels: nothing in the tree names them, so
  // the model has to describe the target and let the vision tier place the tap.
  await agent.act('pick the red pin on the map');
  await expect(screen.getByRole('status')).toHaveText('picked the red pin');
});
