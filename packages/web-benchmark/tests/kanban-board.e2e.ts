import { test } from '@e2edev/web';
import { expect } from 'e2e';

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
    const card = await screen.getByTestId('card-fix-payment-bug').boundingBox();
    const done = await screen.getByTestId('column-done').boundingBox();
    if (card === null || done === null) throw new Error('card or column has no box');
    await screen.swipe({
      from: { x: card.x + card.width / 2, y: card.y + card.height / 2 },
      to: { x: done.x + done.width / 2, y: done.y + done.height / 2 },
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
