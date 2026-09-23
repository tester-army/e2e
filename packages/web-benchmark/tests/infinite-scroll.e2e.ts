import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('scrolls the feed until the Golden Ticket loads, then claims it', async ({ app, screen }) => {
  await app.open('/e/infinite-scroll');
  const feed = screen.getByTestId('feed');
  await expect(feed.getByTestId('feed-item')).toHaveCount(20);
  // The feed is its own scroll container, so the feed pages, not the viewport.
  const claim = screen.getByRole('button', { name: 'Claim' });
  await feed.scrollUntilVisible(claim);
  await expect(feed.getByText('Golden Ticket')).toBeVisible();
  await claim.tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Golden Ticket claimed');
});
