import { test, expect } from 'e2e';
import { z } from 'zod';

/**
 * Mixed-tier flow: agentic steps for intent, deterministic locators for the
 * exact checks. A serial group keeps one app state across the wizard steps.
 */
test.describe('workspace wizard', { serial: true }, () => {
  test('names the workspace', async ({ app, agent, screen }) => {
    await app.open('/wizard');

    await agent.type('the workspace name field', 'Rocketry');
    await agent.tap('the Next button');

    await expect(screen.getByRole('heading', { name: 'Step 2: Plan' })).toBeVisible();
    await agent.assert('the wizard advanced to the plan step');
  });

  test('confirms and creates it', async ({ agent, screen }) => {
    await screen.getByLabel('Plan').selectOption('Pro');
    await agent.tap('the Next button');

    await expect(screen.getByRole('heading', { name: 'Step 3: Confirm' })).toBeVisible();
    await agent.tap('the Create workspace button');

    const summary = await agent.extract('the workspace name and plan from the summary', {
      schema: z.object({ name: z.string(), plan: z.string() }),
    });
    // Agentic tiers are structurally comparable, not textually identical:
    // assert on meaning, not on one model's exact phrasing.
    expect(summary.name).toContain('Rocketry');
    expect(summary.plan).toContain('Pro');
  });
});

test('the agent fills a form and judges the outcome', async ({ app, agent, screen }) => {
  await app.open('/forms');

  await agent.type('the Full name field', 'Ada Lovelace');
  await agent.tap('the Save profile button');

  await expect(screen.getByRole('status')).toHaveText('Saved profile for Ada Lovelace');
  await agent.assert('the form confirms the profile was saved for Ada Lovelace', {
    timeout: 120_000,
  });
});

test('a false judgment is a typed test failure, not a crash', async ({ app, agent }) => {
  await app.open('/forms');

  let code: string | undefined;
  let explanation: string | undefined;
  try {
    await agent.assert('the page shows a completed checkout receipt');
  } catch (cause) {
    const error = cause as { code?: string; explanation?: string };
    code = error.code;
    explanation = error.explanation;
  }

  expect(code).toBe('ASSERTION_FAILED');
  expect(explanation).toBeTruthy();
});
