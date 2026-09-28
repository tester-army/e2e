import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('scrolling', { requires: ['web'], tags: ['scroll'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/scroll');
  });

  test('scrollUntilVisible pages the viewport until a row far down renders', async ({ screen }) => {
    const row = screen.getByRole('button', { name: 'Row 100', exact: true });
    await expect(row).toHaveCount(0);

    await screen.scrollUntilVisible(row);
    await expect(screen.getByRole('status', { name: 'Scroll position' })).not.toHaveText('0');
    await row.tap();
    await expect(screen.getByRole('status', { name: 'Picked row' })).toHaveText('picked Row 100');
  });

  test('scrollUntilVisible on a node pages that node and leaves the page where it was', async ({ screen }) => {
    const pane = screen.getByRole('list', { name: 'Pane' });
    const item = screen.getByRole('button', { name: 'Item 40', exact: true });
    await expect(item).toHaveCount(0);

    await pane.scrollUntilVisible(item);
    await expect(screen.getByRole('status', { name: 'Pane position' })).not.toHaveText('0');
    await expect(screen.getByRole('status', { name: 'Scroll position' })).toHaveText('0');
    await item.tap();
    await expect(screen.getByRole('status', { name: 'Picked row' })).toHaveText('picked Item 40');
  });

  test('a viewport swipe and a wheel gesture both move the page', async ({ screen, web }) => {
    const position = screen.getByRole('status', { name: 'Scroll position' });
    await expect(position).toHaveText('0');

    await screen.swipe({ direction: 'down' });
    await expect(position).not.toHaveText('0');
    const afterSwipe = Number(await position.textContent());
    expect(afterSwipe).toBeGreaterThan(0);

    await web.mouse.wheel(0, 600);
    await expect(position).toHaveText(String(afterSwipe + 600));

    await screen.swipe({ direction: 'up' });
    await expect.poll(async () => Number(await position.textContent())).toBeLessThan(afterSwipe + 600);
  });

  test('a node swipe scrolls only inside a scrollable node', async ({ screen }) => {
    await screen.getByRole('list', { name: 'Pane' }).swipe({ direction: 'down', momentum: 'slow' });
    await expect(screen.getByRole('status', { name: 'Pane position' })).not.toHaveText('0');
    await expect(screen.getByRole('status', { name: 'Scroll position' })).toHaveText('0');
  });
});
