import { test } from '@e2edev/web';
import { expect } from 'e2e';

/**
 * The Golden Row is row index 4321 at 36 px a row, 155 556 px down a 480 px
 * viewport. A slow fling on the table moves three quarters of its height,
 * 360 px, so about 432 strides reach it, and no row passes unseen because a
 * stride is shorter than the viewport; measured at about 160 ms a stride,
 * 70 s in all. Twice that, so a slower CI box fails the scroll and not the
 * attempt; the attempt gets the default budget on top for opening and
 * claiming.
 */
const SCROLL_TIMEOUT_MS = 140_000;

test(
  'scrolls the windowed table to the Golden Row and claims it',
  { timeout: SCROLL_TIMEOUT_MS + 30_000 },
  async ({ app, screen }) => {
    await app.open('/e/virtualized-table');
    const viewport = screen.getByTestId('table-viewport');
    const rows = viewport.getByTestId('table-row');
    const claim = screen.getByRole('button', { name: 'Claim' });
    await expect(rows.first()).toHaveText('Row 1');
    await expect(claim).toBeHidden();

    // The table is its own scroll container, so the table pages, not the page.
    await viewport.scrollUntilVisible(claim, { timeout: SCROLL_TIMEOUT_MS });

    await expect(rows.filter({ hasText: 'Golden Row' })).toHaveText(/^Row 4322/);
    await expect(rows.filter({ hasText: 'Row 1' })).toHaveCount(0);
    await claim.tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Golden Row claimed');
  },
);
