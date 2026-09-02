/**
 * Android-only: the deterministic tier against the views Android Settings
 * actually exposes. Rows are `TextView`s (`android:id/title`) that take a tap;
 * the collapsing toolbar carries the screen title. Android switches expose no
 * checked state through the accessibility tree, so toggling is left to the
 * portable agentic tests.
 */

import { expect, test } from './fixtures.ts';

const ANDROID = { platforms: ['android'] } as const;

test('drills into Network & internet and back with locators only', ANDROID, async ({ app, screen, device }) => {
  await screen.getByText('Network & internet').tap();
  await expect(device.locator('id=com.android.settings:id/collapsing_toolbar')).toHaveText('Network & internet');
  await expect(screen.getByText('Airplane mode')).toBeVisible();

  await app.back();
  await expect(screen.getByText('Network & internet')).toBeVisible();
});

test('finds the search bar by test id and the Google row by text', ANDROID, async ({ screen }) => {
  await expect(screen.getByTestId('com.android.settings:id/search_bar_title')).toHaveText('Search Settings');
  await expect(screen.getByText('Google')).toBeVisible();
});
