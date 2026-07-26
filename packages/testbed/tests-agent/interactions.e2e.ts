import { test, expect } from 'e2e';
import { z } from 'zod';

test('the agent taps, types, and judges the result', async ({ app, agent, screen, web }) => {
  await app.open('/todos');

  await agent.type('the new todo input', 'Buy milk');
  await agent.tap('the Add button');

  await expect(screen.getByTestId('todo')).toHaveCount(1);
  await agent.assert('the todo list contains exactly one item called "Buy milk"');
  await expect(web).toHaveURL('/todos');
});

test('the agent waits for an eventually true condition', async ({ app, agent }) => {
  await app.open('/network');

  await agent.tap('the Load users button');
  // waitFor, assert, and extract keep the specification's 30 s default
  // regardless of actionTimeout, so a live suite states its own budget.
  await agent.waitFor('the network status reports that users finished loading', {
    intervalMs: 500,
    timeout: 120_000,
  });
});

test('the agent extracts structured data validated by a schema', async ({ app, agent, screen }) => {
  await app.open('/todos');

  for (const title of ['Write spec', 'Ship runner']) {
    await agent.type('the new todo input', title);
    await agent.tap('the Add button');
  }
  await expect(screen.getByTestId('todo')).toHaveCount(2);

  const data = await agent.extract('every todo title and how many remain', {
    schema: z.object({
      titles: z.array(z.string()),
      remaining: z.number().int(),
    }),
  });

  expect(data.titles).toContain('Ship runner');
  expect(data.remaining).toBe(2);
});

test('the agent scrolls a long page to reach a control', async ({ app, agent, screen }) => {
  await app.open('/release-notes');

  await agent.scroll({ direction: 'down', momentum: 'fast' });
  await agent.scrollTo('the Acknowledge release notes button');
  await agent.click('the Acknowledge release notes button');

  await expect(screen.getByRole('status')).toHaveText('acknowledged');
});

test(
  'the agent long-presses a control that opens a dialog',
  { requires: ['web'] },
  async ({ app, agent, screen, web }) => {
    await app.open('/dialogs');
    const dispose = await web.onDialog('accept');
    try {
      await agent.longPress('the Delete everything button', { durationMs: 300 });
      await expect(screen.getByRole('status')).toHaveText('deleted');
    } finally {
      await dispose();
    }
  },
);
