import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('assertion mismatch with a short wait', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', 'Playground')).toHaveText('Not the heading', {
    timeout: 300,
  });
});

test('throws a plain string', async ({ app }) => {
  await app.open();
  throw 'a bare string, not an Error';
});

test('throws a multi-line error with control chars', async ({ app }) => {
  await app.open();
  throw new Error('line one\nline two with a bell\n[31mline three pretending to be red[0m');
});

test('passes beside the failures', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', 'Playground')).toBeVisible();
});
