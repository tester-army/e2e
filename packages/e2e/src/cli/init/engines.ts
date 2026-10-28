/** CLI scaffold presets. Engine packages are referenced as generated source, never imported. */

import os from 'node:os';
import { siblingDependency } from './versions.ts';

export interface EnginePreset {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly imports: readonly string[];
  /** A comment written above the target, without the `//`. */
  readonly targetComment?: string;
  /** The target entry, unindented; the scaffold indents it into the `targets` array. */
  readonly target: string;
  /** Config fields beside `targets`, indented as config fields. */
  readonly settings: readonly string[];
  /** The test file name beside other engines' examples: `tests/<file>.e2e.ts`. */
  readonly file: string;
  /** The contributed fixture a test names in `requires` when other engines' targets share the config. */
  readonly fixture: string;
  /** The example test; `options` is the test options argument with its trailing `, `, or empty. */
  readonly example: (options: string) => string;
  readonly aiExample: (options: string) => string;
  /** Whether the run hint sets APP_URL, for engines that drive a URL. */
  readonly needsAppUrl: boolean;
}

/** Builds prompt choices and scaffolds with defaults for the machine running init. */
export function getEnginePresets() {
  const ios = os.platform() === 'darwin';
  return [
    {
      id: 'web',
      label: 'Web',
      hint: 'Playwright',
      dependencies: siblingDependency('@e2e-dev/web'),
      imports: ["import { web } from '@e2e-dev/web';"],
      target: `{
  engine: web(),
  app: {
    url: process.env.APP_URL ?? 'http://localhost:3000',
    // Or let the runner start the dev server:
    // command: { executable: 'npm', args: ['run', 'dev'] },
  },
}`,
      settings: [],
      file: 'web',
      fixture: 'browser',
      example: (options: string) => `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('app opens', ${options}async ({ app, browser }) => {
  await app.open('/');
  await expect(browser.locator('body')).toBeVisible();
});
`,
      aiExample: (options: string) => `
// With the model key in the environment, uncomment:
// test('the agent drives a flow', ${options}async ({ app, agent }) => {
//   await app.open('/');
//   await agent.act('one goal in natural language');
//   await agent.assert('one question about the screen');
// });
`,
      needsAppUrl: true,
    },
    {
      id: 'mobile',
      label: 'Mobile (iOS/Android)',
      hint: 'agent-device',
      dependencies: siblingDependency('@e2e-dev/mobile'),
      imports: ["import { mobile } from '@e2e-dev/mobile';"],
      targetComment: ios ? "Replace Settings with your app's bundle id." : "Replace com.android.settings with your app's package name.",
      target: ios
        ? "{ name: 'ios', engine: mobile({ platform: 'ios' }), app: { bundleId: 'Settings' } }"
        : "{ name: 'android', engine: mobile({ platform: 'android' }), app: { bundleId: 'com.android.settings' } }",
      settings: ['  workers: 1,'],
      file: 'mobile',
      fixture: 'device',
      example: (options: string) => `import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('Settings opens', ${options}async ({ app, screen }) => {
  await app.open();
  await expect(${ios ? "screen.getByRole('button', 'General')" : "screen.getByText('Network & internet')"}).toBeVisible();
});
`,
      aiExample: (options: string) => ios
        ? `
// With the model key in the environment, uncomment:
// test('the agent opens General', ${options}async ({ agent, app, device }) => {
//   await app.open();
//   await agent.act('open General settings');
//   await expect(device.locator('role=NavigationBar id=General')).toBeVisible();
// });
`
        : `
// With the model key in the environment, uncomment:
// test('the agent opens Network settings', ${options}async ({ agent, app, device }) => {
//   await app.open();
//   await agent.act('open Network & internet settings');
//   await expect(device.locator('id=com.android.settings:id/collapsing_toolbar')).toHaveText('Network & internet');
// });
`,
      needsAppUrl: false,
    },
  ] as const satisfies readonly EnginePreset[];
}

export type EngineId = ReturnType<typeof getEnginePresets>[number]['id'];
export const DEFAULT_ENGINE_IDS: readonly EngineId[] = ['web'];

/** Resolves a preset with the common shape used by scaffold generation. */
export function getEnginePreset(id: EngineId): EnginePreset {
  const preset = getEnginePresets().find((entry) => entry.id === id);
  if (preset === undefined) throw new Error(`unknown engine: ${id}`);
  return preset;
}
