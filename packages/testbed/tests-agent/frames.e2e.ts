import { test, expect } from 'e2e';

/**
 * Dogfoods iframe-aware observations: the note field and save button live in
 * an embedded document, so the model selects nodes the runner re-resolves
 * through frame-scoped locators.
 */
test('the agent edits and saves inside an embedded editor', async ({ app, agent, web }) => {
  await app.open('/frames');

  await agent.type('the Note field in the embedded editor', 'ship the frames support');
  await agent.tap('the Save note button');

  await expect(web.frameLocator('#editor').getByRole('status')).toHaveText(
    'saved: ship the frames support',
  );
  await agent.assert('the embedded editor reports the note was saved');
});
