/**
 * TextEdit through the cua engine: the window is observed as a tree, a text
 * area takes a fill, the value reads back, a screenshot lands in the
 * artifacts, and the menu bar answers the desktop fixture.
 */

import { expect } from '@e2edev/e2e';
import { test } from '@e2edev/cua';

test('an untitled document takes text and reads it back', async ({ app, screen, desktop }) => {
  await app.open();
  const editor = screen.getByRole('textbox').first();
  await expect(editor).toBeVisible();
  await editor.fill('Hello from e2e');
  await expect(editor).toHaveValue('Hello from e2e');
  await editor.press('Meta+a');
  await editor.fill('');
  await expect(editor).toHaveValue('');
  const window = await desktop.window();
  expect(window.title).toMatch(/Untitled/);
  await app.screenshot('empty document');
});

test('the menu bar is reachable through the desktop fixture', async ({ app, desktop, screen }) => {
  await app.open();
  await desktop.menu(['Format', 'Make Plain Text']);
  await desktop.hotkey('Escape');
  await expect(screen.getByRole('textbox').first()).toBeVisible();
});
