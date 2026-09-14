/**
 * `vision: 'only'` acts against a real model: the executor sees a screenshot
 * and nothing else, and every target is a point in it. The drawn keypad and
 * wizard are the natural fit (nothing there is marked up); the todo flow is
 * an ordinary marked-up page driven blind, so type_at and press_at resolve
 * points onto listed inputs underneath and the flow is verified in the DOM.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('pixels-only act enters a code on the drawn keypad', async ({ web, agent, screen }) => {
  await web.goto('/canvas-flow');
  await agent.act('on the drawn keypad enter the code 31415 digit by digit, check the display shows it, then press OK', {
    vision: 'only',
  });
  await expect(screen.getByRole('status')).toHaveText('code accepted: 31415');
});

test('pixels-only act walks the drawn wizard', async ({ web, agent, screen }) => {
  await web.goto('/canvas-wizard');
  await agent.act('complete all eight steps of the drawn wizard: on each screen tap the shape its instruction names, then tap Next', {
    vision: 'only',
  });
  await expect(screen.getByRole('status')).toHaveText('wizard done: ok,ok,ok,ok,ok,ok,ok,ok');
});

test('pixels-only act drives a marked-up todo page through points', async ({ web, agent, screen }) => {
  await web.goto('/todos');
  await agent.act('add two todos named "Buy milk" and "Walk the dog", then mark "Buy milk" as done', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('1 remaining');
  await expect(screen.getByText('Buy milk')).toBeVisible();
  await expect(screen.getByText('Walk the dog')).toBeVisible();
});

test('pixel-mode act (vision true) picks a canvas pin without asking for a screenshot', async ({ web, agent, screen }) => {
  await web.goto('/canvas');
  await agent.act('pick the red pin on the map', { vision: true });
  await expect(screen.getByRole('status')).toHaveText('picked the red pin');
});

test('pixels-only act fills a form drawn on a canvas through the keyboard', async ({ web, agent, screen }) => {
  await web.goto('/canvas-form');
  await agent.act('fill the drawn form: Name is Ada, City is Oslo, then press Submit', { vision: 'only' });
  await expect(screen.getByRole('status')).toHaveText('submitted: name=Ada city=Oslo');
});

test('hybrid act fills the drawn form by focusing fields and typing without a target', async ({ web, agent, screen }) => {
  await web.goto('/canvas-form');
  await agent.act('fill the drawn form: Name is Grace, City is Lima, then press Submit');
  await expect(screen.getByRole('status')).toHaveText('submitted: name=Grace city=Lima');
});
