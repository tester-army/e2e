import { test, expect } from 'e2e';

test('hover reveals the card menu action', async ({ app, screen }) => {
  await app.open('/board');

  await screen.getByText('Card actions', { exact: true }).hover();
  await screen.getByRole('button', 'Archive card').tap();

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is archived');
});

test('setInputFiles resolves paths from the project root', async ({ app, screen }) => {
  await app.open('/board');

  await screen.getByLabel('Attachment').setInputFiles('fixtures/attachment.txt');

  await expect(screen.getByLabel('Attachment state')).toHaveText('attachment.txt');
});

test('dragging the card marks it done', async ({ app, screen }) => {
  await app.open('/board');

  await screen.getByText('Design review', { exact: true }).dragTo(screen.getByLabel('Done column'));

  await expect(screen.getByLabel('Board state')).toHaveText('Design review is done');
});
