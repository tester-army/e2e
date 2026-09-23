import { test } from '@e2edev/web';
import { expect } from 'e2e';

test(
  'scrolls the windowed table to the Golden Row and claims it',
  { timeout: 300_000 },
  async ({ app, screen }) => {
    await app.open('/e/virtualized-table');
    const viewport = screen.getByTestId('table-viewport');
    const rows = viewport.getByTestId('table-row');
    const claim = screen.getByRole('button', { name: 'Claim' });
    await expect(rows.first()).toHaveText('Row 1');
    await expect(claim).toBeHidden();

    // The table is its own scroll container, so the table pages, not the page;
    // each step is a short fling, under one table height, so no row passes unseen.
    await viewport.scrollUntilVisible(claim, { timeout: 240_000 });

    await expect(rows.filter({ hasText: 'Golden Row' })).toHaveText(/^Row 4322/);
    await expect(rows.filter({ hasText: 'Row 1' })).toHaveCount(0);
    await claim.tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Golden Row claimed');
  },
);
