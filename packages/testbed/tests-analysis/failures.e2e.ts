import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { test, expect } from 'e2e';

// Every test here fails on purpose against the bug garden. The classification
// the analysis should reach is in the title; compare it with what the run
// prints.

test('test-bug: stale expectation on the home heading', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Book Shop');
});

test('test-bug: locator names a control the screen spells differently', async ({ app, screen }) => {
  await app.open('/catalog');
  await screen.getByRole('button', { name: 'Add to basket' }).first().tap();
});

test('test-bug: agent instruction the screen cannot satisfy', async ({ app, agent }) => {
  await app.open('/');
  await agent.act('open the Settings menu and switch to dark mode');
});

test('app-bug: the Help link leads to a page that does not exist', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('link', { name: 'Help' }).tap();
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Help');
});

test('app-bug: the greeting leaks a template token', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('status', { name: 'Greeting' })).toHaveText(
    'Welcome, Ada! You have 0 item(s) in your cart.',
  );
});

// A flaky result: the first attempt fails, the retry passes, and the failed
// attempt is what gets analyzed (printed after the failures). Attempts run in
// fresh module realms, so first-attempt state lives on disk; the passing
// attempt clears it so the next run starts flaky again. The analysis reads the
// source, so expect it to call the deliberate first-attempt failure a test bug.
test('flaky result: the first attempt fails, the retry passes', { retries: 1 }, async ({ app, screen }) => {
  await app.open('/catalog');
  const marker = new URL('../.e2e/analysis-flaky-marker', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, 'attempted');
    await expect(screen.getByRole('heading', { name: 'Catalogue' })).toBeVisible();
  }
  rmSync(marker, { force: true });
  await expect(screen.getByRole('heading', { name: 'Catalog' })).toBeVisible();
});
