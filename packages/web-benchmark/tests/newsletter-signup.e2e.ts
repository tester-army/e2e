import { test } from '@e2edev/web';
import type { Web } from '@e2edev/web';
import { expect } from 'e2e';

/**
 * Hooks `console.error` in the page so the test can read what the app logged.
 * The planted bug's only trace is a console error; nothing renders.
 */
async function captureConsoleErrors(web: Web): Promise<void> {
  await web.evaluate(() => {
    const store = window as unknown as { e2eConsoleErrors?: string[] };
    store.e2eConsoleErrors = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      store.e2eConsoleErrors?.push(args.map(String).join(' '));
      original(...args);
    };
    return null;
  });
}

/** Reads the console errors captured since `captureConsoleErrors`. */
function consoleErrors(web: Web): Promise<string[]> {
  return web.evaluate(() => (window as unknown as { e2eConsoleErrors?: string[] }).e2eConsoleErrors ?? []);
}

test('subscribe renders no feedback and logs a TypeError (planted bug)', async ({ app, screen, web }) => {
  await app.open('/e/newsletter-signup');
  await captureConsoleErrors(web);
  const email = screen.getByPlaceholder('you@example.com');
  await email.fill('maria.novak@example.com');
  await screen.getByRole('button', { name: 'Subscribe' }).tap();

  await expect(screen.getByTestId('success-message')).not.toBeVisible();
  await expect(screen.getByTestId('error-message')).not.toBeVisible();
  await expect(email).toHaveValue('maria.novak@example.com');
  const errors = await consoleErrors(web);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("Cannot read properties of undefined (reading 'subscribe')");
});
