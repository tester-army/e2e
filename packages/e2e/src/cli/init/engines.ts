/** CLI scaffold presets. Engine packages are referenced as generated source, never imported. */

import os from 'node:os';

export interface EnginePreset {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly imports: readonly string[];
  readonly config: string;
  readonly example: string;
  readonly aiExample?: string;
  readonly runCommand: string;
}

/** Engines version independently of the runner and pin the runner through their own peer range. */
const ENGINE_RANGE = '0.x';

/** Builds prompt choices and scaffolds with defaults for the machine running init. */
export function getEnginePresets() {
  const ios = os.platform() === 'darwin';
  return [
    {
      id: 'playwright',
      label: 'Playwright',
      hint: 'browser testing',
      dependencies: { '@e2edev/playwright': ENGINE_RANGE },
      imports: ["import { playwright } from '@e2edev/playwright';"],
      config: `  // The engine declares the app it drives; APP_URL overrides the default at run time.
  targets: [{
    platform: 'web', // also the target name, unless name is set
    engine: playwright({
      url: process.env.APP_URL ?? 'http://localhost:3000',
      // Let the runner start the dev server and wait for url to answer:
      // command: { executable: 'npm', args: ['run', 'dev'] },
    }),
  }],`,
      example: `import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

test('app opens', async ({ app, web }) => {
  await app.open('/');
  await expect(web.locator('body')).toBeVisible();
});
`,
      aiExample: `
// Runs when E2E_MODEL and E2E_MODEL_API_KEY are set:
// test('the agent drives a flow', async ({ app, agent }) => {
//   await app.open('/');
//   await agent.act('one goal in plain language');
//   await agent.assert('one question about the screen');
// });
`,
      runCommand: 'APP_URL=http://localhost:3000 npx --no-install e2e run',
    },
    {
      id: 'none',
      label: 'None',
      hint: 'HTTP tests or your own engine',
      dependencies: {},
      imports: [],
      config: `  // Add an engine here when your tests need to drive an app.
  targets: [{ name: 'default', platform: 'custom' }],`,
      example: `import { test, expect } from '@e2edev/e2e';

test('app responds', async () => {
  const response = await fetch(process.env.APP_URL ?? 'http://localhost:3000');
  expect(response.ok).toBe(true);
});
`,
      runCommand: 'APP_URL=http://localhost:3000 npx --no-install e2e run',
    },
    {
      id: 'agent-device',
      label: 'agent-device',
      hint: 'mobile testing: iOS and Android',
      dependencies: { '@e2edev/agent-device': ENGINE_RANGE },
      imports: ["import { agentDevice } from '@e2edev/agent-device';"],
      config: ios
        ? `  // Requires Xcode and an iOS simulator. Replace Settings with your app's bundle ID.
  targets: [{ name: 'ios', platform: 'ios', engine: agentDevice({ platform: 'ios', app: 'Settings' }) }],
  workers: 1,`
        : `  // Requires the Android SDK and an emulator. Replace com.android.settings with your app's package.
  targets: [{ name: 'android', platform: 'android', engine: agentDevice({ platform: 'android', app: 'com.android.settings' }) }],
  workers: 1,`,
      example: `import { test } from '@e2edev/agent-device';
import { expect } from '@e2edev/e2e';

test('Settings opens', async ({ screen }) => {
  await expect(${ios ? "screen.getByRole('button', { name: 'General' })" : "screen.getByText('Network & internet')"}).toBeVisible();
});
`,
      aiExample: ios
        ? `
// Runs when E2E_MODEL and E2E_MODEL_API_KEY are set:
// test('the agent opens General', async ({ agent, device }) => {
//   await agent.act('open General settings');
//   await expect(device.locator('role=NavigationBar id=General')).toBeVisible();
// });
`
        : `
// Runs when E2E_MODEL and E2E_MODEL_API_KEY are set:
// test('the agent opens Network settings', async ({ agent, device }) => {
//   await agent.act('open Network & internet settings');
//   await expect(device.locator('id=com.android.settings:id/collapsing_toolbar')).toHaveText('Network & internet');
// });
`,
      runCommand: 'npx --no-install e2e run',
    },
  ] as const satisfies readonly EnginePreset[];
}

export type EngineId = ReturnType<typeof getEnginePresets>[number]['id'];
export const DEFAULT_ENGINE_ID = 'playwright' satisfies EngineId;

/** Resolves a preset with the common shape used by scaffold generation. */
export function getEnginePreset(id: EngineId): EnginePreset {
  const preset = getEnginePresets().find((entry) => entry.id === id);
  if (preset === undefined) throw new Error(`unknown engine: ${id}`);
  return preset;
}
