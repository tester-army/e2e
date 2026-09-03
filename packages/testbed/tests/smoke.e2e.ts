import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('playground renders and navigates', { tags: ['smoke'] }, async ({ app, screen, web }) => {
  await app.open();
  await expect(web).toHaveTitle('Playground');
  await expect(screen.getByRole('heading', { name: 'Playground' })).toBeVisible();

  await screen.getByRole('link', { name: 'Todos' }).tap();
  await expect(web).toHaveURL('/todos');
  await expect(screen.getByRole('heading', { name: 'Todos' })).toBeVisible();

  await app.back();
  await expect(web).toHaveURL('/');
});

test('screenshots capture evidence', { tags: ['smoke'] }, async ({ app }) => {
  await app.open();
  await app.screenshot('landing');
});
