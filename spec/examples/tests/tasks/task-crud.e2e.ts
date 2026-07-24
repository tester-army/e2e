import { test, expect } from 'e2e';

/**
 * Deterministic-heavy tests: a stable, hot feature area where `screen` is
 * the right tier — zero model calls, cross-platform, Playwright/Maestro
 * muscle memory. The agent appears only where judgment beats selectors.
 */
test.describe('tasks', { tags: ['tasks'], session: 'member' }, () => {
  test('create a task', { tags: ['smoke'] }, async ({ app, screen }) => {
    await app.open('/boards/create-fixture');
    await screen.getByRole('button', { name: 'New task' }).tap();
    await screen.getByLabel('Title').fill('Design the launch page');
    await screen.getByLabel('Assignee').tap();
    await screen.getByRole('menuitem', { name: 'Ada Lovelace' }).tap();
    await screen.getByRole('button', { name: 'Create' }).tap();

    await expect(screen.getByText('Design the launch page')).toBeVisible();
  });

  test('complete a task from its row', async ({ app, screen }) => {
    await app.open('/boards/completion-fixture');
    // Chaining = within(): scope to the row, then act inside it.
    const row = screen.getByRole('listitem').filter({ hasText: 'Review launch checklist' });

    await row.getByRole('checkbox', { name: 'Done' }).check();

    await expect(row.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    await expect(screen.getByRole('listitem').filter({ hasText: 'Review launch checklist' })).toHaveCount(1);
  });

  test('reorder by drag', async ({ app, screen }) => {
    await app.open('/boards/reorder-fixture');
    const first = screen.getByRole('listitem').filter({ hasText: 'Reorder first' });
    const last = screen.getByRole('listitem').filter({ hasText: 'Reorder last' });

    await first.dragTo(last);

    await expect(screen.getByRole('listitem').last()).toContainText('Reorder first');
  });

  test('long board scrolls to reveal archived section', async ({ app, screen, agent }) => {
    await app.open('/boards/archive-fixture');
    await screen.scrollUntilVisible(screen.getByRole('heading', { name: 'Archived' }));

    // Judgment call → agent, not selectors:
    await agent.assert('archived tasks appear dimmed and cannot be edited');
  });
});
