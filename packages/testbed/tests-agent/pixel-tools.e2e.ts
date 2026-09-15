/**
 * The pixel tools against a real model: the executor works from the tree,
 * asks for a screenshot when the tree lacks what it needs, and then acts at
 * points in it. The drawn keypad, wizard, and form are the natural fit
 * (nothing there is marked up); the todo flow is an ordinary marked-up page
 * where the tree alone should carry the step.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('enters a code on the drawn keypad through points', async ({ web, agent, screen }) => {
  await web.goto('/canvas-flow');
  await agent.act('on the drawn keypad enter the code 31415 digit by digit, check the display shows it, then press OK');
  await expect(screen.getByRole('status')).toHaveText('code accepted: 31415');
});

test('walks the drawn wizard through points', async ({ web, agent, screen }) => {
  await web.goto('/canvas-wizard');
  await agent.act('complete all eight steps of the drawn wizard: on each screen tap the shape its instruction names, then tap Next');
  await expect(screen.getByRole('status')).toHaveText('wizard done: ok,ok,ok,ok,ok,ok,ok,ok');
});

test('drives a marked-up todo page from the tree', async ({ web, agent, screen }) => {
  await web.goto('/todos');
  const { summary } = await agent.act('add two todos named "Buy milk" and "Walk the dog", then mark "Buy milk" as done');
  await expect(screen.getByRole('status')).toHaveText('1 remaining');
  await expect(screen.getByText('Buy milk')).toBeVisible();
  await expect(screen.getByText('Walk the dog')).toBeVisible();
  expect(summary).not.toContain('screenshot');
});

test('picks a canvas pin; the bare canvas opens with a screenshot', async ({ web, agent, screen }) => {
  await web.goto('/canvas');
  await agent.act('pick the red pin on the map');
  await expect(screen.getByRole('status')).toHaveText('picked the red pin');
});

test('fills a form drawn on a canvas through type_at and the keyboard', async ({ web, agent, screen }) => {
  await web.goto('/canvas-form');
  await agent.act('fill the drawn form: Name is Ada, City is Oslo, then press Submit');
  await expect(screen.getByRole('status')).toHaveText('submitted: name=Ada city=Oslo');
});
