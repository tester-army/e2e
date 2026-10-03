import { test, expect } from 'e2e';

test('adds a todo', async ({ app, screen, agent }) => {
  await app.open('/todos');
  await agent.act('Add a todo named Buy coffee, and verify it is listed.');
  await expect(screen.getByTestId('todo')).toContainText('Buy coffee');
  await agent.assert('The todo list contains Buy coffee.');
});
