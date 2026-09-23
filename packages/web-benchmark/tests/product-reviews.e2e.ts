import { test } from '@e2edev/web';
import { expect } from 'e2e';

test('the running-shoe page lists coffee-grinder reviews (planted bug)', async ({ app, screen }) => {
  await app.open('/e/product-reviews');
  await expect(screen.getByRole('heading', { name: 'Peak Trail Running Shoes' })).toBeVisible();
  await expect(screen.getByText('$139.00 - Sizes 6 to 13 - Ships in 2 days')).toBeVisible();
  await expect(screen.getByRole('heading', { name: /Customer reviews/ })).toContainText('4.7 out of 5');

  const reviews = screen.getByTestId('review-list').getByRole('listitem');
  await expect(reviews).toHaveCount(3);
  await expect(reviews).toContainText(['Marta', 'Deon', 'Priya']);
  await expect(reviews).toContainText(['espresso', 'burrs', 'grind settings']);
  await expect(screen.getByTestId('rev-1')).toContainText('Grinds beans perfectly evenly');
  await expect(screen.getByTestId('rev-1')).not.toContainText('shoe');
});
