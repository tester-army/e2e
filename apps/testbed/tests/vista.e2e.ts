import { test, expect } from 'e2e';

test('Vista checkpoints follow a todo journey', async ({ app, screen }) => {
  await app.open('/todos');
  await expect(screen.getByTestId('todo')).toHaveCount(0);
  await app.vista('empty-list');
  await screen.getByLabel('New todo').fill('Compare the rewrite');
  await screen.getByLabel('New todo').press('Enter');
  await expect(screen.getByTestId('todo')).toHaveCount(1);
  await app.vista('todo-added');
});
