import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('playground renders and navigates', { tags: ['smoke'] }, async ({ app, screen, web }) => {
  await app.open();
  await expect(web).toHaveTitle('Playground');
  await expect(screen.getByRole('heading', { name: 'Playground', level: 1 })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 2 })).toHaveCount(0);

  await screen.getByRole('link', { name: 'Todos' }).tap();
  await expect(web).toHaveURL('/todos');
  await expect(screen.getByRole('heading', { name: 'Todos' })).toBeVisible();

  await app.back();
  await expect(web).toHaveURL('/');
});

test('steps group the calls they wrap', { tags: ['smoke'] }, async ({ app, screen, web }) => {
  await app.open();
  const heading = await test.step('read the landing page', async () => {
    await expect(web).toHaveTitle('Playground');
    return screen.getByRole('heading', { level: 1 }).textContent();
  });
  expect(heading).toBe('Playground');
  await test.step('visit todos', async () => {
    await test.step('follow the link', async () => {
      await screen.getByRole('link', { name: 'Todos' }).tap();
    });
    await expect(web).toHaveURL('/todos');
  });
});

test('screenshots capture evidence', { tags: ['smoke'] }, async ({ app }) => {
  await app.open();
  await app.screenshot('landing');
});

test('value matchers name their check and compare numbers loosely', { tags: ['smoke'] }, async ({ app, screen }) => {
  await app.open();
  const links = await screen.getByRole('link').count();
  expect(links, 'the playground lists its pages').toBeGreaterThanOrEqual(2);
  expect(links / links, 'a ratio of a number to itself').toBeCloseTo(1);
});

// A fact only the running app can tell decides the skip; the step before it stays in the report.
test('skips itself when the playground has no marketplace', { tags: ['smoke'] }, async ({ app, screen }) => {
  await app.open();
  const marketplace = await screen.getByRole('link', { name: 'Marketplace' }).count();
  test.skip(marketplace === 0, 'the playground has no marketplace');
  await screen.getByRole('link', { name: 'Marketplace' }).tap();
});
