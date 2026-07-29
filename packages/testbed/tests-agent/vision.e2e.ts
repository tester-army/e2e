import { test, expect, AgentError } from 'e2e';

/**
 * Dogfoods the vision tier against a surface with no accessibility semantics:
 * the pins and the chart on /canvas are drawn pixels, so the semantic tree
 * cannot name any of them. Without `vision: true` these tests are unwritable.
 *
 * Pointing needs a model that is good at visual grounding, which is a much
 * higher bar than accepting an image. A weak model judges the chart correctly
 * and still returns a plausible-looking wrong coordinate for a pin; the point
 * and the hit-test recorded on the step are how that is told apart from a
 * runner bug. This suite therefore relies on `agent.visionModel`, which the
 * agent config pins; `E2E_VISION_MODEL` sweeps it.
 */

test('the agent judges a drawn chart from pixels', async ({ app, agent }) => {
  await app.open('/canvas');

  // 'only' rather than true: the chart is drawn, so the tree describes nothing
  // relevant and sending it would only offer a cheaper way to guess.
  await agent.assert('the bar chart trends upward from left to right', { vision: 'only' });
});

test('the agent taps a drawn map pin', async ({ app, agent, screen }) => {
  await app.open('/canvas');

  await agent.tap('the red pin on the map', { vision: true });

  await expect(screen.getByRole('status')).toHaveText('picked the red pin');
});

test('the agent distinguishes two drawn pins', async ({ app, agent, screen }) => {
  await app.open('/canvas');

  // 'only': nothing on this canvas is in the tree, so pointing is the whole job
  // and the tree would be dead weight in the request.
  await agent.tap('the blue pin in the lower left of the map', { vision: 'only' });

  await expect(screen.getByRole('status')).toHaveText('picked the blue pin');
});

test('a node-only method refuses pixels-only input', async ({ app, agent }) => {
  // Withholding the tree leaves a point as the only possible answer, and type
  // has nothing to do with one. The runner says so before spending a call.
  await app.open('/todos');

  let denied: unknown;
  try {
    await agent.type('the new todo input', 'nope', { vision: 'only' });
  } catch (error) {
    denied = error;
  }
  expect(denied instanceof AgentError && denied.code).toBe('POLICY_DENIED');
});

test('a semantic control still resolves to a node under vision', async ({ app, agent, screen }) => {
  // Vision is additive: with the tree still in the request, a real control is
  // selected by node and re-resolved through a derived locator as usual.
  await app.open('/todos');

  await agent.type('the new todo input', 'Ship vision', { vision: true });
  await agent.tap('the Add button', { vision: true });

  await expect(screen.getByTestId('todo')).toHaveCount(1);
});
