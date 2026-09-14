import { test, expect } from 'e2e';

test.beforeEach(async ({ app }) => {
  await app.open('/todos');
});

test('deterministic: a locator that is not there', async ({ screen }) => {
  await screen.getByRole('button', { name: 'Add todo item' }).tap();
});

test('deterministic: a wrong expectation', async ({ screen }) => {
  await screen.getByLabel('New todo').fill('Write spec');
  await screen.getByRole('button', { name: 'Add' }).tap();
  await expect(screen.getByRole('status', { name: 'Remaining' })).toHaveText('2 remaining', { timeout: 1500 });
});

test('agentic: the control does not exist', async ({ agent }) => {
  await agent.act('Add a todo named "Groceries", then archive it using the Archive button.');
});
