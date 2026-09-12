/** CLI scaffold presets. Engine packages are referenced as generated source, never imported. */

import os from 'node:os';
import { readJson } from '../../internal/package-version.ts';

export interface EnginePreset {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly imports: readonly string[];
  readonly config: string;
  readonly example: string;
  readonly aiExample?: string;
  /** Whether the run hint sets APP_URL, for engines that drive a URL. */
  readonly needsAppUrl: boolean;
}

/**
 * Engine versions the build records next to this module, in
 * `engine-versions.json`, from the sibling packages' manifests. Absent when
 * running from source.
 */
const ENGINE_VERSIONS = readJson(import.meta.url, './engine-versions.json') as Readonly<Record<string, string>> | undefined;

/**
 * The range init writes for an engine. Engines version independently of the
 * runner and pin it through their own peer range, so init asks for the minor
 * of the engine released alongside this runner. Package managers resolve a
 * range to the registry's `latest` tag whenever it satisfies, and `latest`
 * can trail the tag the runner came from by several minors, so a bare `0.x`
 * installed engines whose peer range rejected the runner.
 */
export function engineRange(version: string | undefined): string {
  return version === undefined ? '0.x' : `^${version}`;
}

function engineDependency(name: string): Readonly<Record<string, string>> {
  return { [name]: engineRange(ENGINE_VERSIONS?.[name]) };
}

/**
 * The range init writes for `playwright`, which `@e2edev/playwright` peers on
 * rather than installs, so an app that already ships Playwright keeps one copy
 * and one browser cache. The build records the version the engine was built
 * and tested against; from source, where nothing is recorded, any 1.x will do.
 */
export function playwrightRange(version: string | undefined): string {
  return version === undefined ? '^1' : `^${version}`;
}

/**
 * The range init writes for `agent-device`, which `@e2edev/agent-device` peers
 * on rather than installs, so a project that already drives devices with the
 * agent-device CLI keeps one copy and one set of sessions. agent-device is
 * 0.x and its minors break, so the range pins the minor the engine was built
 * and tested against; the build records that version, and each agent-device
 * minor moves the range with an engine release. From source, where nothing is
 * recorded, any 0.x will do.
 */
export function agentDeviceRange(version: string | undefined): string {
  if (version === undefined) return '0.x';
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${minor}.x`;
}

/** Builds prompt choices and scaffolds with defaults for the machine running init. */
export function getEnginePresets() {
  const ios = os.platform() === 'darwin';
  return [
    {
      id: 'playwright',
      label: 'Web',
      hint: 'Playwright',
      dependencies: { ...engineDependency('@e2edev/playwright'), playwright: playwrightRange(ENGINE_VERSIONS?.['playwright']) },
      imports: ["import { playwright } from '@e2edev/playwright';"],
      config: `  // The engine declares the app it drives; APP_URL overrides the default at run time.
  targets: [{
    // Named after the platform the engine declares: "web".
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
// Runs once the key the model in e2e.config.ts reads is in the environment:
// test('the agent drives a flow', async ({ app, agent }) => {
//   await app.open('/');
//   await agent.act('one goal in plain language');
//   await agent.assert('one question about the screen');
// });
`,
      needsAppUrl: true,
    },
    {
      id: 'agent-device',
      label: 'Mobile (iOS/Android)',
      hint: 'agent-device',
      dependencies: { ...engineDependency('@e2edev/agent-device'), 'agent-device': agentDeviceRange(ENGINE_VERSIONS?.['agent-device']) },
      imports: ["import { agentDevice } from '@e2edev/agent-device';"],
      config: ios
        ? `  // Requires Xcode and an iOS simulator. Replace Settings with your app's bundle ID.
  targets: [{ name: 'ios', engine: agentDevice({ platform: 'ios', app: 'Settings' }) }],
  workers: 1,`
        : `  // Requires the Android SDK and an emulator. Replace com.android.settings with your app's package.
  targets: [{ name: 'android', engine: agentDevice({ platform: 'android', app: 'com.android.settings' }) }],
  workers: 1,`,
      example: `import { test } from '@e2edev/agent-device';
import { expect } from '@e2edev/e2e';

test('Settings opens', async ({ screen }) => {
  await expect(${ios ? "screen.getByRole('button', { name: 'General' })" : "screen.getByText('Network & internet')"}).toBeVisible();
});
`,
      aiExample: ios
        ? `
// Runs once the key the model in e2e.config.ts reads is in the environment:
// test('the agent opens General', async ({ agent, device }) => {
//   await agent.act('open General settings');
//   await expect(device.locator('role=NavigationBar id=General')).toBeVisible();
// });
`
        : `
// Runs once the key the model in e2e.config.ts reads is in the environment:
// test('the agent opens Network settings', async ({ agent, device }) => {
//   await agent.act('open Network & internet settings');
//   await expect(device.locator('id=com.android.settings:id/collapsing_toolbar')).toHaveText('Network & internet');
// });
`,
      needsAppUrl: false,
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
      needsAppUrl: true,
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
