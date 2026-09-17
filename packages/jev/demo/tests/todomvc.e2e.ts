import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('a todo list, driven by Jev', async ({ app, agent, screen }) => {
  await app.open('/todomvc');

  await agent.act('Add a todo item "Buy milk"');
  await agent.act('Add a todo item "Walk the dog"');
  await agent.assert('the list shows two todos, none completed');

  await agent.act('Mark the "Buy milk" todo as completed');
  await agent.act('Show only the completed todos');
  await agent.assert('only "Buy milk" is listed and the Completed filter is selected');

  await agent.act('Show all todos again');
  await agent.act('Clear all completed todos');
  await expect(screen.getByTestId('todo-item')).toHaveCount(1);
  await agent.assert('"Walk the dog" is the only todo left and 1 item is left');
});

test('a value the step leaves open goes to the fallback', async ({ app, agent, screen }) => {
  await app.open('/todomvc');
  await agent.act('Add a todo for any grocery item of your choice');
  await expect(screen.getByTestId('todo-item')).toHaveCount(1);
});
