/**
 * Agent tier on a mobile target: real observation and real driver actions
 * through `@e2edev/agent-device`, with an in-memory daemon standing in for a
 * device and a scripted model so the assertions stay deterministic.
 *
 * The agent tier is the one surface that consumes `session.observe` and
 * `session.actions.*` rather than the locator engine, so it needs its own
 * coverage on a mobile driver.
 */

import { describe, expect, it } from 'vitest';
import { agentDevice } from '@e2edev/agent-device';
import { createFakeDaemon, type NodeSpec } from '../helpers/fake-daemon.ts';
import {
  fakeCalls,
  installFakeModel,
  judgment,
  locateBestMatch,
  locatePoint,
} from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';
import type { E2EConfig } from '../../src/index.ts';

const SCREEN: readonly NodeSpec[] = [
  {
    type: 'XCUIElementTypeApplication',
    label: 'Example',
    rect: { x: 0, y: 0, width: 402, height: 874 },
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

function mobileAgentConfig(model: unknown): {
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
        },
      ],
      artifacts: [],
      agent: { model },
    } as unknown as E2EConfig,
  };
}

describe('agent tier on a mobile target', () => {
  it(
    'locates and acts through the semantic observation',
    async () => {
      const model = installFakeModel((call) =>
        call.schemaName === 'agent-judgment-1' ? judgment(true, 'visible') : locateBestMatch(call),
      );
      const { config, daemon } = mobileAgentConfig(model);
      const { outcome, project } = await runProject(
        {
          'tests/agent.e2e.ts': `import { test } from 'e2e';

test('drives the app with the agent', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the Continue button');
  await agent.type('the Email field', 'user@example.test');
  await agent.longPress('the Continue button', { durationMs: 150 });
  await agent.scroll({ direction: 'down' });
  await agent.assert('the welcome message is visible');
});
`,
        },
        { appUrl: '', config },
      );

      expect(resultByTitle(outcome, 'drives the app with the agent').status).toBe('passed');
      // Every located action reached the device as a real command.
      const commands = daemon.commands();
      expect(commands).toContain('click');
      expect(commands).toContain('fill');
      expect(commands).toContain('longpress');
      expect(commands).toContain('scroll');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'serializes the mobile observation with roles the model can target',
    async () => {
      const model = installFakeModel((call) => locateBestMatch(call));
      const { config } = mobileAgentConfig(model);
      const { outcome, project } = await runProject(
        {
          'tests/observe.e2e.ts': `import { test } from 'e2e';

test('observes once', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the Continue button');
});
`,
        },
        { appUrl: '', config },
      );

      expect(resultByTitle(outcome, 'observes once').status).toBe('passed');
      const call = fakeCalls[0]!;
      // The projection's ARIA roles are what the model sees, not iOS types.
      expect(call.observation).toContain('button');
      expect(call.observation).toContain('Continue');
      expect(call.observation).toContain('textbox');
      expect(call.observation).not.toContain('XCUIElementType');
      // The platform accessibility identifier reaches the model as a test id.
      // `screen.testIdAttribute` names a DOM attribute and is web-only
      // (spec 16-mobile.md), so a mobile driver fills the neutral key instead
      // and the runner must read that one on a mobile target.
      expect(call.observation).toContain('testid="email"');
      // One revision per observation, and every line is bound to it.
      expect(call.revision).not.toBe('');
      project.cleanup();
    },
    60_000,
  );

  it(
    'scrolls a distant target all the way into view before acting on it',
    async () => {
      // A mobile observation carries nodes far below the fold, so the model can
      // locate this row without the runner having scrolled at all. One
      // `scrollIntoView` gesture lands far short of 2,400 points, and the tap
      // that follows would fail on a node the test just asked for.
      const model = installFakeModel((call) => locateBestMatch(call));
      const daemon = createFakeDaemon({
        scrollStep: 400,
        screen: () => [
          {
            type: 'XCUIElementTypeApplication',
            rect: { x: 0, y: 0, width: 402, height: 874 },
            children: [
              {
                // A scroll container imposes no bounds on its children, which
                // is what lets a row below the fold keep real geometry.
                type: 'XCUIElementTypeScrollView',
                rect: { x: 0, y: 0, width: 402, height: 874 },
                children: [
                  {
                    type: 'XCUIElementTypeButton',
                    label: 'Development Overrides',
                    rect: { x: 20, y: 2400, width: 280, height: 48 },
                  },
                ],
              },
            ],
          },
        ],
      });
      const { outcome, project } = await runProject(
        {
          'tests/reach.e2e.ts': `import { test } from 'e2e';

test('reaches a row below the fold', async ({ app, agent }) => {
  await app.open();
  await agent.scrollTo('the Development Overrides row');
  await agent.tap('the Development Overrides row');
});
`,
        },
        {
          appUrl: '',
          config: {
            specVersion: '0.1',
            targets: [
              {
                name: 'ios',
                platform: 'ios',
                driver: agentDevice({ transport: daemon.transport }),
                app: 'com.example.app',
              },
            ],
            artifacts: [],
            agent: { model },
          } as unknown as E2EConfig,
        },
      );

      expect(resultByTitle(outcome, 'reaches a row below the fold').status).toBe('passed');
      // It kept scrolling until the row was actually reachable, rather than
      // reporting success after the single gesture the driver contract defines.
      expect(daemon.scrollOffset()).toBeGreaterThanOrEqual(2400 - 874);
      expect(daemon.commands()).toContain('click');
      project.cleanup();
    },
    60_000,
  );

  it(
    'points at a viewport coordinate through the vision tier',
    async () => {
      const model = installFakeModel((call) =>
        // The Continue button's center in the image space the driver reported.
        call.images.length > 0 ? locatePoint(call, { x: 320, y: 488 }) : locateBestMatch(call),
      );
      const { config, daemon } = mobileAgentConfig(model);
      const { outcome, project } = await runProject(
        {
          'tests/vision.e2e.ts': `import { test } from 'e2e';

test('taps a point', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the Continue button', { vision: 'only' });
});
`,
        },
        { appUrl: '', config },
      );

      expect(resultByTitle(outcome, 'taps a point').status).toBe('passed');
      // Pixels reached the model, and the point dispatched as a coordinate tap.
      expect(fakeCalls[0]?.images).toHaveLength(1);
      const click = daemon.calls.find((entry) => entry.command === 'click');
      expect(click?.positionals).toHaveLength(2);
      project.cleanup();
    },
    60_000,
  );

  it(
    'omits pixels from the observation when a secure field is visible',
    async () => {
      const model = installFakeModel((call) => locateBestMatch(call));
      const daemon = createFakeDaemon({
        screen: () => [
          {
            type: 'XCUIElementTypeApplication',
            rect: { x: 0, y: 0, width: 402, height: 874 },
            children: [
              {
                type: 'XCUIElementTypeSecureTextField',
                label: 'Password',
                value: 'hunter2',
                rect: { x: 20, y: 100, width: 280, height: 44 },
              },
              {
                type: 'XCUIElementTypeButton',
                label: 'Continue',
                rect: { x: 20, y: 220, width: 280, height: 48 },
              },
            ],
          },
        ],
      });
      const { outcome, project } = await runProject(
        {
          'tests/secure.e2e.ts': `import { test } from 'e2e';

test('never sends a secure screen as pixels', async ({ app, agent }) => {
  await app.open();
  await agent.tap('the Continue button');
});
`,
        },
        {
          appUrl: '',
          config: {
            specVersion: '0.1',
            targets: [
              {
                name: 'ios',
                platform: 'ios',
                driver: agentDevice({ transport: daemon.transport }),
                app: 'com.example.app',
              },
            ],
            artifacts: [],
            agent: { model },
          } as unknown as E2EConfig,
        },
      );

      expect(resultByTitle(outcome, 'never sends a secure screen as pixels').status).toBe('passed');
      expect(fakeCalls[0]?.images).toHaveLength(0);
      // The secret never appears in the prompt either.
      expect(fakeCalls[0]?.observation).not.toContain('hunter2');
      project.cleanup();
    },
    60_000,
  );
});
