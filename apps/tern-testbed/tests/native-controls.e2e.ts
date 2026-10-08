import { expect, test } from 'e2e';

test('native values and actions, not delivery receipts', async ({ screen }) => {
  const field = screen.getByPlaceholder('Value');
  await expect(field).toBeVisible();
  await field.fill('quotes " and Unicode λ\nsecond line');
  await expect(field).toHaveValue('quotes " and Unicode λ\nsecond line');
  await field.clear();
  await expect(field).toHaveValue('');
  await screen.getByRole('button', { name: 'Increment' }).click();
  await expect(screen.getByText('Count: 1')).toBeVisible();
});

test('duplicate semantic labels remain ambiguous', async ({ screen }) => {
  expect(await screen.getByLabel('Duplicate').count()).toBe(2);
});

test('native control roles and states are real rendered semantics', async ({ screen }) => {
  const checkbox = screen.getByRole('checkbox', { name: 'Subscribe' });
  await expect(checkbox).toBeChecked({ checked: false });
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  const toggle = screen.getByRole('switch', { name: 'Enabled' });
  await expect(toggle).toBeChecked({ checked: false });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(screen.getByRole('meter', { name: 'Thinking effort' })).toBeVisible();
  await expect(screen.getByRole('checkbox', { name: 'Disabled control' })).toBeDisabled();
  await expect(screen.getByText('Hidden sentinel')).toBeHidden();
});
