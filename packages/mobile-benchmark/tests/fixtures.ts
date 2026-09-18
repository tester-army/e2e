/**
 * The suite's `test`: the one `@e2edev/agent-device` exports, typed with the
 * engine's contributed `device` fixture. `expect` is `e2e`'s.
 */

import type { Device } from '@e2edev/agent-device';
import type { Screen } from 'e2e';
import { expect } from 'e2e';

export { test } from '@e2edev/agent-device';
export { expect } from 'e2e';

/**
 * Every attempt opens the app on its home list, where each scenario is a row
 * whose test id is the scenario name (`src/App.tsx`). Tapping it pushes the
 * scenario as its own screen. The list is three screens tall and iOS only
 * projects the rows on screen into the tree, so the row is scrolled to first.
 */
export async function openScenario(
  { device, screen }: { device: Device; screen: Screen },
  name: string,
): Promise<void> {
  // A fresh launch shows the list from the top; scrolling before its first
  // row exists would run past the target while the bundle is still loading.
  await expect(screen.getByTestId('Login Form')).toBeVisible();
  const row = screen.getByTestId(name);
  // The viewport scroll flings the list, and iOS reports every row at its
  // final frame while the pixels are still moving, so a tap after it lands
  // rows away. Dragging the list itself leaves it at rest. A row only enters
  // the tree once it is fully on screen, so the drags are a quarter of the
  // list: shorter than any row, which no row can straddle at every stop.
  const list = device.locator('role=ScrollView');
  await expect
    .poll(async () => {
      if (await row.isVisible()) return true;
      await list.swipe({ direction: 'down', momentum: 'slow' });
      return false;
    }, { timeout: 60_000 })
    .toBe(true);
  // The tap gets one more try when the home header stays, which is what a
  // tap the list swallowed leaves behind.
  const homeHeader = screen.getByTestId('Benchmark Examples');
  await row.tap();
  try {
    await homeHeader.waitFor({ state: 'hidden', timeout: 3_000 });
  } catch {
    await row.tap();
    await homeHeader.waitFor({ state: 'hidden', timeout: 3_000 });
  }
}
