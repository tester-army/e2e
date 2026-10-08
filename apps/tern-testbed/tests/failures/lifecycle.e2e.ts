import { expect, test } from 'e2e';

test('cleanup after an actual native action, including its retry', { retries: 1 }, async ({ screen }) => {
  const field=screen.getByPlaceholder('Value');
  await field.fill('deliberate-failure');
  await expect(field).toHaveValue('deliberate-failure');
  throw new Error('Expected fixture failure after actual native semantic proof');
});

test('attempt deadline releases its actual native client', { timeout: 20000 }, async ({ screen }) => {
  await expect(screen.getByPlaceholder('Value')).toBeVisible();
  await new Promise<void>(()=>{}); // Deliberate deadline case; the runner must end the real attempt and clean its lease.
});
