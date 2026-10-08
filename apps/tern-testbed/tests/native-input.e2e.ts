import { expect, test } from 'e2e';
test('persistent named-seat Control and pointer have semantic effects', async ({ screen }) => {
  const field = screen.getByPlaceholder('Value');
  await field.fill('preserved draft');
  await field.press('Control+a');
  await field.pressSequentially('replacement');
  await expect(field).toHaveValue('replacement');
  await field.press('End');
  await field.pressSequentially('!');
  await expect(field).toHaveValue('replacement!');
  await screen.getByRole('button', { name: 'Increment' }).click();
  await expect(screen.getByText('Count: 1')).toBeVisible();
  await field.focus();
  await field.pressSequentially('tail');
  await expect(field).toHaveValue('replacement!tail');
});
