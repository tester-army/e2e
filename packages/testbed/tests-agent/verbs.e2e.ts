import { test, expect } from 'e2e';

/**
 * Dogfoods the located-action verbs beyond tap/type: every step is one
 * bounded locate plus a predetermined runner action. Deterministic expects
 * pin each outcome so the assertions stay comparable across models.
 */
test('the agent searches the board with the keyboard', async ({ app, agent, screen }) => {
  await app.open('/board');

  await agent.type('the Search cards field', 'design');
  await agent.press('the Search cards field', 'Enter');

  await expect(screen.getByLabel('Search state')).toHaveText('searched: design');
});

test('the agent hovers to reveal a menu and archives the card', async ({ app, agent, screen }) => {
  await app.open('/board');

  await agent.hover('the Card actions zone');
  await agent.tap('the Archive card button');

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is archived');
});

test('the agent drags a card into the done column', async ({ app, agent, screen }) => {
  await app.open('/board');

  await agent.dragTo('the Design review card', 'the Done column');

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is done');
});

test('the agent uploads an attachment from test-owned files', async ({ app, agent, screen }) => {
  await app.open('/board');

  // The path comes from test code and resolves from the project root; the
  // model only ever selects the input.
  await agent.upload('the Attachment file input', 'fixtures/attachment.txt');

  await expect(screen.getByLabel('Attachment state')).toHaveText('attachment.txt');
});

test('the agent drives native form controls', async ({ app, agent, screen }) => {
  await app.open('/forms');

  await agent.select('the Team dropdown', 'Mobile');
  await expect(screen.getByLabel('Team')).toHaveValue('mobile');

  await agent.check('the Email notifications checkbox');
  await expect(screen.getByLabel('Email notifications')).toBeChecked();

  await agent.uncheck('the Weekly digest checkbox');
  await expect(screen.getByLabel('Weekly digest')).not.toBeChecked();
});
