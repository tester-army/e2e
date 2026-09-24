/**
 * The suite's `test`: the one `@e2edev/mobile` exports, typed with the
 * engine's contributed `device` fixture. `expect` is `e2e`'s.
 */

import type { Device } from '@e2edev/mobile';
import type { App, Screen } from 'e2e';
import { expect } from 'e2e';

export { test } from '@e2edev/mobile';
export { expect } from 'e2e';

/**
 * Launches the app fresh, on its home list, and opens one scenario from it.
 * The list is two columns of compact rows with every scenario on screen
 * (`src/App.tsx`), so a scenario is one tap away and never scrolled to. A row is found by its label, "<name>. " and
 * the description: its test id is the name too, which the iOS navigation bar
 * takes as its identifier once the scenario is up. A scenario is up once its
 * row has left the tree (both platforms drop the list when a screen is
 * pushed; the home title stays on iOS as the back button's label) and its
 * own header shows the route name, on iOS in the navigation bar and on
 * Android in the toolbar; Bottom Tabs, the one route without a header, shows
 * its home tab instead. The tap gets one more try when the list swallowed it
 * or a neighbour opened, which is popped first. A sheet the scenario itself
 * presents on entry (Stripe's PaymentSheet, within the budget on a fast
 * runner) hides the header the same way; back dismisses it, and the scenario
 * is up once the header shows.
 */
export async function openScenario(
  { app, device, screen }: { app: App; device: Device; screen: Screen },
  name: string,
): Promise<void> {
  await app.open();
  const row = screen.getByLabel(`${name}. `, { exact: false });
  await expect(row).toBeVisible();
  const shown = name === 'Bottom Tabs' ? screen.getByTestId('home-tab-content') : screen.getByText(name);
  const opened = async (): Promise<boolean> => (await row.isHidden()) && (await shown.isVisible());
  await row.tap();
  // Ten seconds: a screen that boots a payment SDK takes a while to push on
  // a loaded CI Mac, and a pop in the middle of it leaves the list behind.
  try {
    await expect.poll(opened, { timeout: 10_000 }).toBe(true);
  } catch {
    if (await row.isHidden()) {
      await device.back();
      await expect.poll(async () => (await row.isVisible()) || (await opened()), { timeout: 5_000 }).toBe(true);
      if (await opened()) return;
    }
    await row.tap();
    await expect.poll(opened, { timeout: 5_000 }).toBe(true);
  }
}
