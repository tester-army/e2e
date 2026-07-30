import { expect, test } from 'e2e';

/**
 * Longer agent flows against Settings. These are the cases where the agent tier
 * carries real risk on mobile: several located actions in sequence, each one
 * invalidating every node reference from the previous observation, and targets
 * the model can only reach by scrolling.
 *
 * Agentic assertions are structurally comparable across models, not textually
 * identical, so every agentic step is paired with a deterministic check.
 */

test('walks two levels deep with located actions only', async ({ app, agent, screen }) => {
  await app.open();

  await agent.tap('the General row in the settings list');
  await expect(screen.getByText('About')).toBeVisible();

  // A second located action against a freshly observed screen: the refs from
  // the first observation are stale by now, so this fails loudly if the agent
  // tier ever reuses them.
  await agent.tap('the About row');
  await expect(screen.getByText('Name')).toBeVisible();

  await app.back();
  await app.back();
  await expect(screen.getByText('Accessibility')).toBeVisible();
});

test('reaches a row below the fold by scrolling to it', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByText('Accessibility').first().tap();

  // The model must scroll before it can act: mobile-0.1 never scrolls
  // implicitly, and an out-of-viewport node reports itself as offscreen.
  await agent.scrollTo('the Keyboards & Typing row');
  await agent.tap('the Keyboards & Typing row');
  await expect(screen.getByText('Full Keyboard Access')).toBeVisible();
});

test('reaches a target thousands of points below the fold', async ({ app, agent, screen }) => {
  await app.open();
  await agent.scrollTo('the Developer row');
  await agent.tap('the Developer row');
  await expect(screen.getByText('Dark Appearance')).toBeVisible();

  // Developer is a very long list: this row sits roughly 3,000 points down, far
  // beyond what one gesture covers. The model locates it on its first judgment
  // regardless, because the observation carries nodes below the fold, so this
  // fails the moment `scrollTo` stops at "found" instead of "reachable".
  await agent.scrollTo('the Development Overrides row');
  await agent.tap('the Development Overrides row');
  await expect(screen.getByText('URL Override')).toBeVisible();
});

test('types into the search field through the agent', async ({ app, agent, screen }) => {
  await app.open();

  await agent.type('the search field at the top of the settings list', 'accessibility');
  const search = screen.getByRole('searchbox');
  expect(await search.inputValue()).toContain('accessibility');

  // Leave the query cleared: Settings persists it across launches.
  await search.clear();
});

test('judges the screen and extracts structured data', async ({ app, agent, screen }) => {
  await app.open();

  // Judged on the screen the launch guarantees. Hanging an agentic judgment off
  // a separate navigation step makes a model call report that step's timing
  // instead of the thing under test.
  await agent.assert('this screen shows a list of settings the user can open');

  // Extraction is judged against the screen rather than against a hard-coded
  // string: "the first row" has more than one defensible answer, but a real
  // label must resolve back to a node that is actually there. That catches a
  // hallucinated value while staying comparable across models.
  const data = await agent.extract('the label of one row in this list', {
    schema: {
      '~standard': {
        version: 1,
        vendor: 'testbed',
        validate: (value: unknown) => {
          if (
            typeof value === 'object' &&
            value !== null &&
            typeof (value as { label?: unknown }).label === 'string'
          ) {
            return { value: value as { label: string } };
          }
          return { issues: [{ message: 'expected { label: string }' }] };
        },
      },
    },
  });
  expect(data.label.length).toBeGreaterThan(0);
  expect(await screen.getByText(data.label).count()).toBeGreaterThan(0);
});

test('refuses an impossible target instead of tapping something else', async ({ app, agent }) => {
  await app.open();

  // A described target that does not exist must fail, not resolve to the
  // nearest plausible row: a wrong tap on a settings screen is a real mutation.
  const missing = await agent
    .tap('the Launch Nuclear Missiles row', { timeout: 30_000 })
    .then(() => null)
    .catch((cause: unknown) => cause);
  expect(missing instanceof Error).toBe(true);
});
