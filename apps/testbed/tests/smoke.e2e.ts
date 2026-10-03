import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('playground renders and navigates', { tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await app.open();
  await expect(browser).toHaveTitle('Playground');
  await expect(screen.getByRole('heading', { name: 'Playground', level: 1 })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 2 })).toHaveCount(0);

  await screen.getByRole('link', 'Todos').tap();
  await expect(browser).toHaveURL('/todos');
  await expect(screen.getByRole('heading', 'Todos')).toBeVisible();

  await app.back();
  await expect(browser).toHaveURL('/');
});

test('screenshots capture evidence', { tags: ['smoke'] }, async ({ app }) => {
  await app.open();
  await app.screenshot('landing');
});

// Every passed step leaves a frame of the screen it left; the report links each to its step.
test('every step leaves a screenshot', { tags: ['smoke'], screenshot: 'every-step' }, async ({ app, screen, browser }) => {
  await app.open();
  await screen.getByRole('link', 'Todos').tap();
  await expect(browser).toHaveURL('/todos');
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
  const marketplace = await screen.getByRole('link', 'Marketplace').count();
  test.skip(marketplace === 0, 'the playground has no marketplace');
  await screen.getByRole('link', 'Marketplace').tap();
});
