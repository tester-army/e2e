/**
 * The suite's `test`: the one `@e2edev/agent-device` exports, typed with the
 * engine's contributed `device` fixture. `expect` is `e2e`'s.
 */

import type { Screen } from 'e2e';

export { test } from '@e2edev/agent-device';
export { expect } from 'e2e';

/**
 * Every attempt opens the app on its home list, where each scenario is a row
 * whose test id is the scenario name (`src/App.tsx`). Tapping it pushes the
 * scenario as its own screen.
 */
export async function openScenario(screen: Screen, name: string): Promise<void> {
  await screen.getByTestId(name).tap();
}
