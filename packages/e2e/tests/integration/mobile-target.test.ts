/**
 * End-to-end mobile execution: the real runner, the real `@e2edev/agent-device`
 * driver, and an in-memory daemon in place of a simulator. It proves the
 * runner-side gates, the fixtures, and `report-1` mobile provenance.
 */

import { describe, expect, it } from 'vitest';
import { agentDevice } from '@e2edev/agent-device';
import { createFakeDaemon, type NodeSpec } from '../helpers/fake-daemon.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';
import type { E2EConfig } from '../../src/index.ts';

const SCREEN: readonly NodeSpec[] = [
  {
    type: 'XCUIElementTypeApplication',
    label: 'Example',
    children: [
      {
        type: 'XCUIElementTypeStaticText',
        label: 'Welcome back',
        rect: { x: 20, y: 40, width: 280, height: 20 },
      },
      {
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'email',
        rect: { x: 20, y: 100, width: 280, height: 44 },
      },
      {
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 20, y: 220, width: 280, height: 48 },
      },
    ],
  },
];

/** A mobile-only config: no app URL, because mobile-0.1 has no base URL. */
function mobileConfig(extra: Partial<E2EConfig> = {}): {
  config: E2EConfig;
  daemon: ReturnType<typeof createFakeDaemon>;
} {
  const daemon = createFakeDaemon({ screen: () => SCREEN });
  return {
    daemon,
    config: {
      specVersion: '0.1',
      targets: [
        {
          name: 'ios',
          platform: 'ios',
          driver: agentDevice({ transport: daemon.transport }),
          app: 'com.example.app',
          device: 'iPhone 16',
          os: '18.0',
        },
      ],
      artifacts: [],
      ...extra,
    } as E2EConfig,
  };
}

describe('mobile target execution', () => {
  it(
    'runs a mobile test with no app URL configured',
    async () => {
      const { config, daemon } = mobileConfig();
      const { outcome, project } = await runProject(
        {
          'tests/login.e2e.ts': `import { test, expect } from 'e2e';

test('signs in', async ({ app, screen, platform }) => {
  expect(platform).toBe('ios');
  await app.open();
  await expect(screen.getByText('Welcome back')).toBeVisible();
  await screen.getByLabel('Email').fill('user@example.com');
  await screen.getByRole('button', { name: 'Continue' }).tap();
});
`,
        },
        { appUrl: '', config },
      );

      expect(resultByTitle(outcome, 'signs in').status).toBe('passed');
      // The driver drove a real command sequence, ending in the tap.
      expect(daemon.commands()).toContain('fill');
      expect(daemon.commands()).toContain('click');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'records mobile target provenance and omits web-only fields',
    async () => {
      const { config } = mobileConfig();
      const { outcome, project } = await runProject(
        {
          'tests/observe.e2e.ts': `import { test } from 'e2e';

test('opens the app', async ({ app }) => {
  await app.open();
  await app.screenshot('home');
});
`,
        },
        { appUrl: '', config },
      );

      expect(resultByTitle(outcome, 'opens the app').status).toBe('passed');
      const target = outcome.report.run.targets[0]!;
      expect(target.platform).toBe('ios');
      expect(target.device).toBe('iPhone 16');
      expect(target.os).toBe('18.0');
      expect(target.browser).toBeUndefined();
      expect(target.browserVersion).toBeUndefined();
      expect(target.baseOrigin).toBeUndefined();
      expect(target.capabilities).toEqual(['device']);
      expect(target.artifactCapabilities).toEqual(['screenshot', 'video']);
      expect(target.stateCapability).toBe(false);
      expect(target.driver).toMatchObject({ id: 'agent-device', spiVersion: 1 });
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'exposes the device fixture and records its steps',
    async () => {
      const { config, daemon } = mobileConfig();
      const { outcome, project } = await runProject(
        {
          'tests/device.e2e.ts': `import { test } from 'e2e';

test('drives device controls', { requires: ['device'] }, async ({ app, device }) => {
  await app.open();
  await device.setPermission('notifications', 'allow');
  await device.pushNotification({ aps: { alert: 'Hi' } });
  await device.home();
});
`,
        },
        { appUrl: '', config },
      );

      const result = resultByTitle(outcome, 'drives device controls');
      expect(result.status).toBe('passed');
      const steps = result.attempts[0]!.steps.filter((step) => step.kind === 'device');
      expect(steps.map((step) => step.api)).toEqual([
        'device.setPermission',
        'device.pushNotification',
        'device.home',
      ]);
      expect(daemon.commands()).toContain('push');
      expect(daemon.commands()).toContain('home');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'skips a test requiring the web capability instead of failing it',
    async () => {
      const { config } = mobileConfig();
      const { outcome, project } = await runProject(
        {
          'tests/web.e2e.ts': `import { test } from 'e2e';

test('needs web', { requires: ['web'] }, async ({ app }) => {
  await app.open();
});

test('needs only mobile', async ({ app }) => {
  await app.open();
});
`,
        },
        { appUrl: '', config },
      );

      const skipped = resultByTitle(outcome, 'needs web');
      expect(skipped.status).toBe('skipped');
      expect(skipped.skip?.cause).toBe('capability-unavailable');
      expect(resultByTitle(outcome, 'needs only mobile').status).toBe('passed');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'rejects a configured trace artifact before launching anything',
    async () => {
      const { config, daemon } = mobileConfig({ artifacts: ['screenshot', 'trace'] });
      const { outcome, project } = await runProject(
        {
          'tests/trace.e2e.ts': `import { test } from 'e2e';

test('never runs', async ({ app }) => {
  await app.open();
});
`,
        },
        { appUrl: '', config },
      );

      expect(outcome.report.run.status).toBe('error');
      expect(JSON.stringify(outcome.report)).toContain('UNSUPPORTED_ARTIFACT');
      // Nothing touched the device.
      expect(daemon.commands()).toEqual([]);
      project.cleanup();
    },
    60_000,
  );

  it(
    'still requires an app URL when a web target is present',
    async () => {
      const daemon = createFakeDaemon({ screen: () => SCREEN });
      const { outcome, project } = await runProject(
        { 'tests/mixed.e2e.ts': `import { test } from 'e2e';\ntest('x', async () => {});\n` },
        {
          appUrl: '',
          config: {
            specVersion: '0.1',
            targets: [
              { name: 'web', platform: 'web' },
              {
                name: 'ios',
                platform: 'ios',
                driver: agentDevice({ transport: daemon.transport }),
                app: 'com.example.app',
              },
            ],
          } as E2EConfig,
        },
      );

      expect(outcome.report.run.status).toBe('error');
      expect(JSON.stringify(outcome.report)).toContain('APP_URL_REQUIRED');
      project.cleanup();
    },
    60_000,
  );
});
