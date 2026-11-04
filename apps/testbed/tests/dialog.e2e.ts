/**
 * Adapted from microsoft/playwright tests/page/page-dialog.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `page.on('dialog')` is `browser.onDialog`. A dialog no
 * handler answers is dismissed as in Playwright, and e2e also fails the next step for it.
 */

/*
 * Not ported:
 * - should fire dialogclosed when dialog is accepted: the dialogclosed event.
 * - should fire dialogclosed when dialog is dismissed: the dialogclosed event.
 * - should fire dialogclosed for auto-dismissed dialogs: the dialogclosed event.
 * - should be able to close context with open alert: e2e answers every dialog, so none stays open.
 * The `defaultValue()` assertions of the kept tests are dropped: e2e dialogs have no default value.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { content } from './helpers.ts';

/** What `act` threw, or undefined when it did not throw. */
async function failure(act: () => unknown): Promise<unknown> {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
}

test.describe('page dialog', { requires: ['browser'], tags: ['playwright'] }, () => {
  test('should fire', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.onDialog(async (dialog) => {
      expect(dialog.type).toBe('alert');
      expect(dialog.message).toBe('yo');
      await dialog.accept();
    });
    await browser.evaluate("() => alert('yo')");
  });

  test('should allow accepting prompts', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.onDialog(async (dialog) => {
      expect(dialog.type).toBe('prompt');
      expect(dialog.message).toBe('question?');
      await dialog.accept('answer!');
    });
    const result = await browser.evaluate("() => prompt('question?', 'yes.')");
    expect(result).toBe('answer!');
  });

  test('should dismiss the prompt', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.onDialog((dialog) => dialog.dismiss());
    const result = await browser.evaluate("() => prompt('question?')");
    expect(result).toBe(null);
  });

  test('should accept the confirm prompt', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.onDialog(async (dialog) => {
      await dialog.accept();
    });
    const result = await browser.evaluate("() => confirm('boolean?')");
    expect(result).toBe(true);
  });

  test('should dismiss the confirm prompt', async ({ browser }) => {
    await browser.goto('/empty.html');
    await browser.onDialog(async (dialog) => {
      await dialog.dismiss();
    });
    const result = await browser.evaluate("() => confirm('boolean?')");
    expect(result).toBe(false);
  });

  test('should handle multiple alerts', async ({ browser }) => {
    await browser.onDialog(async (dialog) => {
      await dialog.accept().catch(() => {});
    });
    await browser.goto(content(`
      <p>Hello World</p>
      <script>
        alert('Please dismiss this dialog');
        alert('Please dismiss this dialog');
        alert('Please dismiss this dialog');
      </script>
    `));
    expect(await browser.locator('p').textContent()).toBe('Hello World');
  });

  test('should handle multiple confirms', async ({ browser }) => {
    await browser.onDialog(async (dialog) => {
      await dialog.accept().catch(() => {});
    });
    await browser.goto(content(`
      <p>Hello World</p>
      <script>
        confirm('Please confirm me?');
        confirm('Please confirm me?');
        confirm('Please confirm me?');
      </script>
    `));
    expect(await browser.locator('p').textContent()).toBe('Hello World');
  });

  test('should auto-dismiss the prompt without listeners', async ({ browser }) => {
    await browser.goto('/empty.html');
    const result = await browser.evaluate("() => prompt('question?')");
    expect(result).toBe(null);
    expect(String(await failure(() => browser.title()))).toContain('unhandled prompt dialog: question?');
  });

  test('should auto-dismiss the alert without listeners', async ({ browser }) => {
    await browser.goto(content(`<div onclick="window.alert(123); window._clicked=true">Click me</div>`));
    const error = await failure(async () => {
      await browser.locator('div').tap();
      await browser.title();
    });
    expect(String(error)).toContain('unhandled alert dialog: 123');
    expect(await browser.evaluate('window._clicked')).toBe(true);
  });
});
