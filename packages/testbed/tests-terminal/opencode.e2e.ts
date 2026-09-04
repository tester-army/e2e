/**
 * OpenCode's TUI through the deterministic tier only: the `screen` queries
 * read columns of the terminal, `terminal` types and presses keys, and
 * nothing here spends a model call. Every arrangement is checked through
 * what the screen shows, never through OpenCode's internals. A row's text
 * is one node per column, so a query names the column exactly or matches a
 * regular expression against it.
 */

import { expect, test } from './fixtures.ts';

test('shows the prompt, the agent, and the model on launch', async ({ screen, terminal }) => {
  await expect(screen.getByText(/^Ask anything/)).toBeVisible();
  await expect(screen.getByText(/^Build .*Anthropic/)).toBeVisible();
  await expect(screen.getByText('ctrl+p commands')).toBeVisible();
  const cursor = await terminal.cursor();
  expect(cursor.y).toBeGreaterThan(0);
});

test('opens the command palette with a slash and closes it with Escape', async ({ screen, terminal }) => {
  await terminal.type('/');
  await expect(screen.getByText('/help')).toBeVisible();
  await expect(screen.getByText('/exit')).toBeVisible();
  await terminal.press('Escape');
  await expect(screen.getByText('/help')).not.toBeVisible();
});

test('switches between the Build and Plan agents with Tab', async ({ screen, terminal }) => {
  await expect(screen.getByText(/^Build .*Anthropic/)).toBeVisible();
  await terminal.press('Tab');
  await expect(screen.getByText(/^Plan .*Anthropic/)).toBeVisible();
  await expect(screen.getByText(/^Build .*Anthropic/)).not.toBeVisible();
  await terminal.press('Tab');
  await expect(screen.getByText(/^Build .*Anthropic/)).toBeVisible();
});

test('opens and dismisses the help dialog', async ({ screen, terminal }) => {
  await terminal.type('/help');
  await terminal.press('Enter');
  await expect(screen.getByText('Help')).toBeVisible();
  await expect(screen.getByText(/ctrl\+p to see all available actions/)).toBeVisible();
  await terminal.press('Escape');
  await expect(screen.getByText(/ctrl\+p to see all available actions/)).not.toBeVisible();
});

test('restarts to a fresh prompt after typing', async ({ app, screen, terminal }) => {
  await terminal.type('draft that must not survive a restart');
  await expect(screen.getByText(/must not survive/)).toBeVisible();
  await app.restart();
  await expect(screen.getByText(/^Ask anything/)).toBeVisible();
  await expect(screen.getByText(/must not survive/)).not.toBeVisible();
});

test('quits with /exit and leaves the final screen behind', async ({ screen, terminal }) => {
  await terminal.type('/exit');
  await terminal.press('Enter');
  await terminal.waitForExit();
  expect(await terminal.exited()).toBe(true);
  await expect(screen.getByText(/the program exited/)).toBeVisible();
});
