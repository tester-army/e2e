import { test, expect } from 'e2e';

/**
 * Deterministic-heavy tests: a stable, hot feature area where `screen` is
 * the right tier — zero model calls, cross-platform, Playwright/Maestro
 * muscle memory. The agent appears only where judgment beats selectors.
 */
test.describe('tasks', { tags: ['tasks'], session: 'member' }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/boards/rocketry');
  });

  test('create a task', { tags: ['smoke'] }, async ({ screen }) => {
    await screen.getByRole('button', { name: 'New task' }).tap();
    await screen.getByLabel('Title').fill('Design the launch page');
    await screen.getByLabel('Assignee').tap();
    await screen.getByRole('menuitem', { name: 'Ada Lovelace' }).tap();
    await screen.getByRole('button', { name: 'Create' }).tap();

    await expect(screen.getByText('Design the launch page')).toBeVisible();
  });

  test('complete a task from its row', async ({ screen }) => {
    // Chaining = within(): scope to the row, then act inside it.
    const row = screen.getByRole('listitem').filter({ hasText: 'Design the launch page' });

    await row.getByRole('checkbox', { name: 'Done' }).check();

    await expect(row.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    await expect(screen.getByRole('listitem').filter({ hasText: 'Design the launch page' })).toHaveCount(1);
  });

  test('reorder by drag', async ({ screen }) => {
    const first = screen.getByRole('listitem').first();
    const last = screen.getByRole('listitem').last();

    await first.dragTo(last);

    await expect(screen.getByRole('listitem').last()).toContainText('Design the launch page');
  });

  test('long board scrolls to reveal archived section', async ({ screen, agent }) => {
    await screen.scrollUntilVisible(screen.getByRole('heading', { name: 'Archived' }));

    // Judgment call → agent, not selectors:
    await agent.assert('archived tasks appear dimmed and cannot be edited');
  });
});
