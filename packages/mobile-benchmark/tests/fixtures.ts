/**
 * The suite's `test`: the one `@e2edev/mobile` exports, typed with the
 * engine's contributed `device` fixture. `expect` is `e2e`'s.
 */

import type { Device } from '@e2edev/mobile';
import type { Screen } from 'e2e';
import { expect } from 'e2e';

export { test } from '@e2edev/mobile';
export { expect } from 'e2e';

/**
 * Every attempt opens the app on its home list, two columns of compact rows
 * with every scenario on screen (`src/App.tsx`), so a scenario is one tap
 * away and never scrolled to. A scenario is up once the home header is gone
 * and its navigation bar, when it shows one, carries the route name as its
 * identifier; Bottom Tabs is the one route without a navigation bar, so no
 * bar means that scenario. The tap gets one more try when the list swallowed
 * it or a neighbour opened, which is popped first.
 */
export async function openScenario(
  { device, screen }: { device: Device; screen: Screen },
  name: string,
): Promise<void> {
  const row = screen.getByTestId(name);
  await expect(row).toBeVisible();
  const homeHeader = screen.getByTestId('Benchmark Examples');
  const bars = device.locator('role=NavigationBar');
  const title = device.locator(`role=NavigationBar id=${JSON.stringify(name)}`);
  const headerless = name === 'Bottom Tabs';
  const opened = async (): Promise<boolean> =>
    !(await homeHeader.isVisible()) && (headerless ? (await bars.count()) === 0 : (await title.count()) === 1);
  await row.tap();
  try {
    await expect.poll(opened, { timeout: 5_000 }).toBe(true);
  } catch {
    if (!(await homeHeader.isVisible())) await device.back();
    await row.tap();
    await expect.poll(opened, { timeout: 5_000 }).toBe(true);
  }
}
