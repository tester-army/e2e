import { test, expect } from '@e2edev/e2e';

test.describe('todos', { tags: ['todos'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/todos');
  });

  test('adds todos with the button and the keyboard', async ({ screen }) => {
    await screen.getByLabel('New todo').fill('Write spec');
    await screen.getByRole('button', { name: 'Add' }).tap();
    await screen.getByLabel('New todo').fill('Ship runner');
    await screen.getByLabel('New todo').press('Enter');

    await expect(screen.getByTestId('todo')).toHaveCount(2);
    await expect(screen.getByTestId('todo').first()).toContainText('Write spec');
    await expect(screen.getByTestId('todo').last()).toContainText('Ship runner');
    await expect(screen.getByRole('status', { name: 'Remaining' })).toHaveText('2 remaining');
  });

  test('ignores empty submissions', async ({ screen }) => {
    await screen.getByRole('button', { name: 'Add' }).tap();
    await expect(screen.getByTestId('todo')).toHaveCount(0);
  });

  test('completes and filters todos', async ({ screen }) => {
    for (const title of ['One', 'Two', 'Three']) {
      await screen.getByLabel('New todo').fill(title);
      await screen.getByLabel('New todo').press('Enter');
    }
    await screen.getByLabel('Two').check();
    await expect(screen.getByLabel('Two')).toBeChecked();
    await expect(screen.getByRole('status', { name: 'Remaining' })).toHaveText('2 remaining');

    await screen.getByRole('tab', { name: 'Open' }).tap();
    await expect(screen.getByRole('tab', { name: 'Open' })).toBeSelected();
    await expect(screen.getByTestId('todo')).toHaveCount(2);
    await expect(screen.getByText('Two')).toBeHidden();

    await screen.getByRole('tab', { name: 'Done' }).tap();
    await expect(screen.getByTestId('todo')).toHaveCount(1);
    await expect(screen.getByTestId('todo').first()).toContainText('Two');

    await screen.getByRole('tab', { name: 'All' }).tap();
    await expect(screen.getByTestId('todo')).toHaveCount(3);
  });

  test('deletes todos', async ({ screen }) => {
    await screen.getByLabel('New todo').fill('Disposable');
    await screen.getByLabel('New todo').press('Enter');
    await screen.getByRole('button', { name: 'Delete Disposable' }).tap();
    await expect(screen.getByTestId('todo')).toHaveCount(0);
    await expect(screen.getByRole('status', { name: 'Remaining' })).toHaveText('0 remaining');
  });

  test('persists across restart and clears with clearState', async ({ app, screen }) => {
    await screen.getByLabel('New todo').fill('Survive restart');
    await screen.getByLabel('New todo').press('Enter');
    await expect(screen.getByTestId('todo')).toHaveCount(1);

    await app.restart();
    await app.open('/todos');
    await expect(screen.getByTestId('todo')).toHaveCount(1);
    await expect(screen.getByTestId('todo').first()).toContainText('Survive restart');

    await app.clearState();
    await app.open('/todos');
    await expect(screen.getByTestId('todo')).toHaveCount(0);
  });

  test('attempts start from a logically fresh session', async ({ screen }) => {
    // Storage written by earlier tests in this file must not leak in.
    await expect(screen.getByTestId('todo')).toHaveCount(0);
  });
});
