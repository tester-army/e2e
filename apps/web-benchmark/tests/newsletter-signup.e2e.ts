import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';

type ConsoleErrorStore = Window & { e2eConsoleErrors?: string[] };

/**
 * Hooks `console.error` in the page and returns a reader of what the app has
 * logged since. The planted bug's only trace is a console error, and the
 * engine has no `browser.onConsole` yet, so the page keeps the list itself.
 */
async function captureConsoleErrors(browser: Browser): Promise<() => Promise<string[]>> {
  await browser.evaluate(() => {
    const errors: string[] = [];
    (window as ConsoleErrorStore).e2eConsoleErrors = errors;
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
      original(...args);
    };
    return null;
  });
  return () => browser.evaluate(() => (window as ConsoleErrorStore).e2eConsoleErrors ?? []);
}

test('subscribe renders no feedback and logs a TypeError (planted bug)', async ({ app, screen, browser }) => {
  await app.open('/e/newsletter-signup');
  const consoleErrors = await captureConsoleErrors(browser);
  const email = screen.getByPlaceholder('you@example.com');
  await email.fill('maria.novak@example.com');
  await screen.getByRole('button', 'Subscribe').tap();

  await expect(screen.getByTestId('success-message')).not.toBeVisible();
  await expect(screen.getByTestId('error-message')).not.toBeVisible();
  await expect(email).toHaveValue('maria.novak@example.com');
  await expect.poll(async () => (await consoleErrors()).join('\n')).toContain(
    "Cannot read properties of undefined (reading 'subscribe')",
  );
});
