import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('scrolling', { tags: ['scroll'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/scroll');
  });

  test('scrollUntilVisible reaches a row far down the page', async ({ screen }) => {
    const row = screen.getByRole('button', { name: 'Row 100', exact: true });
    await screen.scrollUntilVisible(row);
    await row.tap();
    await expect(screen.getByRole('status', { name: 'Picked row' })).toHaveText('picked Row 100');
  });

  test('scrollUntilVisible loads a lazy feed until the target renders', async ({ screen }) => {
    const post = screen.getByRole('button', { name: 'Post 55', exact: true });
    await expect(post).toHaveCount(0);
    await screen.scrollUntilVisible(post, { timeout: 60_000 });
    await expect(post).toBeVisible();
    await post.tap();
    await expect(screen.getByRole('status', { name: 'Picked row' })).toHaveText('picked Post 55');
  });

  test('a viewport swipe and a wheel gesture both move the page', async ({ screen, web }) => {
    const position = screen.getByRole('status', { name: 'Scroll position' });
    await expect(position).toHaveText('0');

    await screen.swipe({ direction: 'down' });
    await expect(position).not.toHaveText('0');
    const afterSwipe = Number(await position.textContent());
    expect(afterSwipe).toBeGreaterThan(0);

    await web.mouse.wheel(0, 600);
    await expect.poll(async () => Number(await position.textContent())).toBeGreaterThan(afterSwipe);

    await screen.swipe({ direction: 'up', momentum: 'fast' });
    await expect.poll(async () => Number(await position.textContent())).toBeLessThan(afterSwipe + 600);
  });

  test('a node swipe scrolls only inside a scrollable node', async ({ screen }) => {
    const list = screen.getByRole('list', { name: 'Rows' });
    await list.swipe({ direction: 'down', momentum: 'slow' });
    await expect(screen.getByRole('status', { name: 'Scroll position' })).not.toHaveText('0');
  });
});
