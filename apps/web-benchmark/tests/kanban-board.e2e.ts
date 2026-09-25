import { test } from '@e2edev/web';
import { expect } from 'e2e';
import { centerOf } from './support.ts';

test.describe('kanban board', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/kanban-board');
  });

  test('pointer drags move both cards into the goal layout', async ({ screen }) => {
    const done = screen.getByTestId('column-done');
    const inProgress = screen.getByTestId('column-in-progress');

    await screen.getByTestId('card-fix-payment-bug').dragTo(done);
    await expect(done.getByText('Fix payment bug')).toBeVisible();
    await expect(done.getByText('Empty')).toBeHidden();

    await screen.getByTestId('card-refactor-onboarding').dragTo(inProgress);
    await expect(inProgress.getByText('Refactor onboarding')).toBeVisible();
    await expect(screen.getByTestId('column-todo').getByText('Update pricing page')).toBeVisible();

    await screen.getByRole('button', { name: 'Submit board' }).tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Board matches the goal');
  });

  test('a swipe along a path drags a card as well', async ({ screen }) => {
    await screen.swipe({
      from: await centerOf(screen.getByTestId('card-fix-payment-bug')),
      to: await centerOf(screen.getByTestId('column-done')),
    });
    await expect(screen.getByTestId('column-done').getByText('Fix payment bug')).toBeVisible();
  });

  test('a plain tap moves nothing and the untouched board is rejected', async ({ screen }) => {
    await screen.getByTestId('card-fix-payment-bug').tap();
    await expect(screen.getByTestId('column-todo').getByText('Fix payment bug')).toBeVisible();
    await screen.getByRole('button', { name: 'Submit board' }).tap();
    await expect(screen.getByTestId('error-message')).toHaveText('Board does not match the goal yet');
  });
});
