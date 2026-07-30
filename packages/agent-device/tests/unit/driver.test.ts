/**
 * Drives the real `mobile-0.1` driver against an in-memory daemon. Only the
 * device is fake: the driver builds every request and parses every response.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentDevice } from '../../src/index.ts';
import { DriverError, type DriverContext, type DriverSession } from 'e2e/driver';
import { createFakeDaemon, type FakeDaemon } from '../helpers/fake-daemon.ts';
import type { NodeSpec } from '../helpers/snapshot.ts';

const LOGIN_SCREEN: readonly NodeSpec[] = [
  {
    type: 'XCUIElementTypeApplication',
    label: 'Example',
    children: [
      {
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'email',
        rect: { x: 20, y: 100, width: 280, height: 44 },
      },
      {
        type: 'XCUIElementTypeSecureTextField',
        label: 'Password',
        value: 'hunter2',
        rect: { x: 20, y: 160, width: 280, height: 44 },
      },
      {
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 20, y: 220, width: 280, height: 48 },
      },
      {
        type: 'XCUIElementTypeButton',
        label: 'Disabled',
        enabled: false,
        rect: { x: 20, y: 280, width: 280, height: 48 },
      },
    ],
  },
];

let artifactsDir: string;

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const controller = new AbortController();
  const operation = {
    signal: controller.signal,
    timeoutMs: 5_000,
    runId: 'run-1',
    attemptId: 'attempt-1',
  };
  return {
    target: { name: 'ios', platform: 'ios', app: 'com.example.app', driver: {} as never },
    targetId: 'ios',
    app: {
      allowedOrigins: [],
      environment: 'test',
      allowProduction: false,
      testIdAttribute: 'data-testid',
    },
    artifactsDir,
    runId: 'run-1',
    attemptId: 'attempt-1',
    operation,
    launchOptions: { headed: false },
    ...overrides,
  } as DriverContext;
}

const cleanup = { signal: new AbortController().signal, timeoutMs: 5_000, runId: 'run-1', attemptId: 'attempt-1' };

/**
 * Launches a session and opens the app, which is what a test body does first.
 * Launch itself leaves the app not yet foreground.
 */
async function launch(
  daemon: FakeDaemon,
  options: { readonly open?: boolean } = {},
): Promise<{ session: DriverSession; dispose: () => Promise<void> }> {
  const driver = agentDevice({ transport: daemon.transport });
  const session = await driver.launch(context());
  if (options.open !== false) await session.app.open(undefined, context().operation);
  return { session, dispose: async () => driver.dispose?.() ?? undefined };
}

beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-'));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe('agentDevice manifest', () => {
  it('declares mobile-0.1 capabilities and no trace or state', () => {
    const driver = agentDevice();
    expect(driver.id).toBe('agent-device');
    expect(driver.platforms).toEqual(['ios', 'android']);
    expect(driver.capabilities).toEqual({
      fixtures: ['device'],
      artifacts: ['screenshot', 'video'],
      state: false,
    });
  });
});

describe('launch', () => {
  it('boots a device and clears app state without launching the app', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon, { open: false });
    // Launch leaves the app not yet foreground, so the attempt's own app.open
    // is the single launch. Resetting here and launching there costs one app
    // start per attempt instead of two.
    // A run first releases any device its own abandoned sessions still hold.
    expect(daemon.commands()).toEqual(['session_list', 'devices', 'boot', 'settings']);
    const settings = daemon.calls.find((call) => call.command === 'settings');
    expect(settings?.positionals).toEqual(['clear-app-state', 'com.example.app']);

    await session.app.open(undefined, context().operation);
    // Launching animates, so the app settles before anything observes it: a
    // direct read during a transition would return the previous screen.
    expect(daemon.commands()).toEqual([
      'session_list',
      'devices',
      'boot',
      'settings',
      'open',
      'wait',
    ]);
    await session.close(cleanup);
    await dispose();
  });

  it('skips the state reset when the app cannot be cleared', async () => {
    // A built-in system app has no data container to clear; app.open replaces
    // the running instance, so the attempt still starts against a fresh app.
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const driver = agentDevice({ transport: daemon.transport, reset: 'relaunch' });
    const session = await driver.launch(context());
    expect(daemon.commands()).toEqual(['session_list', 'devices', 'boot']);
    await session.close(cleanup);
    await driver.dispose?.();
  });

  it('rejects UI operations before the app is open', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon, { open: false });
    await expect(session.observe(context().operation)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await session.close(cleanup);
    await dispose();
  });

  it('installs a build artifact and derives identity from it', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const driver = agentDevice({ transport: daemon.transport });
    const session = await driver.launch(
      context({
        target: { name: 'ios', platform: 'ios', app: './build/MyApp.app', driver: {} as never },
      }),
    );
    const install = daemon.calls.find((call) => call.command === 'install');
    expect(install?.positionals[0]).toMatch(/build\/MyApp\.app$/);
    // Later commands use the identity the artifact reported, not the filename.
    await session.app.open(undefined, context().operation);
    const open = daemon.calls.find((call) => call.command === 'open');
    expect(open?.positionals[0]).toBe('com.example.app');
    await session.close(cleanup);
    await driver.dispose?.();
  });

  it('rejects a physical device instead of degrading', async () => {
    const daemon = createFakeDaemon({
      devices: [{ id: 'DEV-1', name: 'Oskar iPhone', kind: 'device' }],
    });
    const driver = agentDevice({ transport: daemon.transport });
    await expect(driver.launch(context())).rejects.toThrow(/physical device/);
  });

  it('matches a device name across separator and case changes', async () => {
    // An Android AVD is configured as `Medium_Phone_API_36.1` and reports
    // itself as `Medium Phone API 36.1` once booted.
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      devices: [
        { id: 'emulator-5554', name: 'Medium Phone API 36.1', kind: 'emulator', booted: true },
      ],
    });
    const driver = agentDevice({ transport: daemon.transport });
    const session = await driver.launch(
      context({
        target: {
          name: 'android',
          platform: 'android',
          app: 'com.example.app',
          device: 'Medium_Phone_API_36.1',
          driver: {} as never,
        },
      }),
    );
    expect(daemon.commands()).toContain('boot');
    await session.close(cleanup);
    await driver.dispose?.();
  });

  it('matches a device by its id, so a serial or udid works', async () => {
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      devices: [{ id: 'emulator-5554', name: 'Pixel', kind: 'emulator', booted: true }],
    });
    const driver = agentDevice({ transport: daemon.transport });
    const session = await driver.launch(
      context({
        target: {
          name: 'android',
          platform: 'android',
          app: 'com.example.app',
          device: 'emulator-5554',
          driver: {} as never,
        },
      }),
    );
    expect(daemon.commands()).toContain('boot');
    await session.close(cleanup);
    await driver.dispose?.();
  });

  it('fails when no device matches the requested selector', async () => {
    const daemon = createFakeDaemon();
    const driver = agentDevice({ transport: daemon.transport });
    await expect(
      driver.launch(
        context({
          target: {
            name: 'ios',
            platform: 'ios',
            app: 'com.example.app',
            device: 'iPhone 4',
            driver: {} as never,
          },
        }),
      ),
    ).rejects.toThrow(/no ios simulator or emulator matches/);
  });

  it('rejects a non-mobile target before touching a device', async () => {
    const daemon = createFakeDaemon();
    const driver = agentDevice({ transport: daemon.transport });
    await expect(
      driver.launch(context({ target: { name: 'web', platform: 'web' } })),
    ).rejects.toThrow(/drives ios and android targets/);
    expect(daemon.commands()).toEqual([]);
  });
});

describe('screen', () => {
  it('resolves a locator against a captured snapshot', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      context().operation,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ id: 'e4' });
    await session.close(cleanup);
    await dispose();
  });

  it('reads a node whole and masks a secure value', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Password', exact: true } } },
      context().operation,
    );
    const node = await session.screen.read(refs[0]!, context().operation);
    expect(node.states?.secure).toBe(true);
    expect(node.value).toBeUndefined();
    expect(node.inputPurpose).toBe('password');
    await session.close(cleanup);
    await dispose();
  });

  it('reports a ref from a superseded revision as retryable NODE_STALE', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      op,
    );
    await session.screen.perform(refs[0]!, { kind: 'tap' }, op);
    const error = await session.screen.read(refs[0]!, op).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DriverError);
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
    await session.close(cleanup);
    await dispose();
  });

  it('acts on a node the backend flags as not hittable', async () => {
    // Real iOS reports hittable: false for tappable controls whenever the
    // simulator window is not frontmost; gating on it would break every tap.
    const daemon = createFakeDaemon({
      screen: () => [
        {
          type: 'XCUIElementTypeButton',
          label: 'Continue',
          hittable: false,
          rect: { x: 20, y: 220, width: 280, height: 48 },
        },
      ],
    });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      op,
    );
    await session.screen.perform(refs[0]!, { kind: 'tap' }, op);
    expect(daemon.commands()).toContain('click');
    await session.close(cleanup);
    await dispose();
  });

  it('refuses to act on a node scrolled outside the viewport', async () => {
    const daemon = createFakeDaemon({
      screen: () => [
        {
          type: 'XCUIElementTypeApplication',
          rect: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            {
              // A scroll container, so the row below the fold keeps its geometry.
              type: 'XCUIElementTypeTable',
              rect: { x: 0, y: 0, width: 402, height: 874 },
              children: [
                {
                  type: 'XCUIElementTypeButton',
                  label: 'Below fold',
                  rect: { x: 0, y: 2000, width: 402, height: 44 },
                },
              ],
            },
          ],
        },
      ],
    });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Below fold', exact: true } } },
      op,
    );
    const error = await session.screen
      .perform(refs[0]!, { kind: 'tap' }, op)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
    expect(String((error as Error).message)).toContain('scroll it into view');
    expect(daemon.commands()).not.toContain('click');
    await session.close(cleanup);
    await dispose();
  });

  it('dispatches a switch action at the inner control, not the row wrapper', async () => {
    // The wrapper carries the human label but its center lies on the row text,
    // where a tap does nothing at all.
    const daemon = createFakeDaemon({
      screen: () => [
        {
          type: 'XCUIElementTypeSwitch',
          label: 'Reduce Motion',
          value: '1',
          rect: { x: 36, y: 146, width: 330, height: 28 },
          children: [
            {
              type: 'XCUIElementTypeSwitch',
              label: '1',
              value: '1',
              rect: { x: 305, y: 146, width: 63, height: 28 },
            },
          ],
        },
      ],
    });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      {
        kind: 'query',
        query: {
          kind: 'role',
          value: { kind: 'string', value: 'switch', exact: true },
          name: { kind: 'string', value: 'Reduce Motion', exact: true },
        },
      },
      op,
    );
    expect(refs[0]?.id).toBe('e1');
    await session.screen.perform(refs[0]!, { kind: 'uncheck' }, op);
    const click = daemon.calls.find((call) => call.command === 'click');
    expect(click?.positionals).toEqual(['@e2']);
    await session.close(cleanup);
    await dispose();
  });

  it('clears a field with one delete key per character', async () => {
    // The backend has no clear command and rejects empty fill text.
    const daemon = createFakeDaemon({
      screen: () => [
        {
          type: 'XCUIElementTypeTextField',
          label: 'Email',
          value: 'abc',
          rect: { x: 20, y: 100, width: 280, height: 44 },
        },
      ],
    });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } } },
      op,
    );
    await session.screen.perform(refs[0]!, { kind: 'clear' }, op);
    const typed = daemon.calls.find((call) => call.command === 'type');
    expect(typed?.positionals[0]).toBe('\u0008\u0008\u0008');
    // Focus first, because typing goes to the focused field.
    expect(daemon.commands()).toContain('focus');
    await session.close(cleanup);
    await dispose();
  });

  it('skips clearing a field that is already empty', async () => {
    const daemon = createFakeDaemon({
      screen: () => [
        {
          type: 'XCUIElementTypeTextField',
          label: 'Email',
          rect: { x: 20, y: 100, width: 280, height: 44 },
        },
      ],
    });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } } },
      op,
    );
    await session.screen.perform(refs[0]!, { kind: 'clear' }, op);
    expect(daemon.commands()).not.toContain('type');
    await session.close(cleanup);
    await dispose();
  });

  it('refuses to act on a disabled node without retargeting', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Disabled', exact: true } } },
      op,
    );
    const error = await session.screen
      .perform(refs[0]!, { kind: 'tap' }, op)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', retryable: false });
    expect(daemon.commands()).not.toContain('click');
    await session.close(cleanup);
    await dispose();
  });

  it('treats a failure after dispatch as possibly committed', async () => {
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      failAlways: { click: { code: 'COMMAND_FAILED', message: 'tap lost' } },
    });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Continue', exact: true } } },
      op,
    );
    const error = await session.screen
      .perform(refs[0]!, { kind: 'tap' }, op)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    await session.close(cleanup);
    await dispose();
  });

  it('rejects frames and web selectors as unsupported', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    await expect(
      session.screen.resolve({ kind: 'web-selector', selector: '.btn' }, context().operation),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await session.close(cleanup);
    await dispose();
  });
});

describe('observe', () => {
  it('returns one revision with a tree and complete redaction', async () => {
    const daemon = createFakeDaemon({
      screen: () => [{ type: 'XCUIElementTypeButton', label: 'Only', rect: { x: 0, y: 0, width: 10, height: 10 } }],
    });
    const { session, dispose } = await launch(daemon);
    const observation = await session.observe(context().operation, { pixels: true });
    expect(observation.tree.ref.revision).toBe(observation.revision);
    expect(observation.redaction).toEqual({
      secureNodeCount: 0,
      maskedRegionCount: 0,
      complete: true,
    });
    expect(observation.pixels?.mediaType).toBe('image/png');
    expect(observation.pixels?.width).toBe(750);
    // Image pixels per point, the space rect coordinates live in.
    expect(observation.pixels?.scale).toBe(2);
    expect(observation.viewport).toEqual({ width: 375, height: 667, scale: 2 });
    await session.close(cleanup);
    await dispose();
  });

  it('omits pixels rather than leaking a visible secure field', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const observation = await session.observe(context().operation, { pixels: true });
    expect(observation.pixels).toBeUndefined();
    expect(observation.redaction.secureNodeCount).toBe(1);
    // Redaction is still complete: the tree is masked and no pixels were sent.
    expect(observation.redaction.complete).toBe(true);
    await session.close(cleanup);
    await dispose();
  });

  it('omits pixels when the backend cannot capture them', async () => {
    const daemon = createFakeDaemon({
      screen: () => [{ type: 'XCUIElementTypeButton', label: 'Only' }],
      failAlways: { screenshot: { code: 'COMMAND_FAILED', message: 'no display' } },
    });
    const { session, dispose } = await launch(daemon);
    const observation = await session.observe(context().operation, { pixels: true });
    expect(observation.pixels).toBeUndefined();
    expect(observation.tree).toBeDefined();
    await session.close(cleanup);
    await dispose();
  });
});

describe('artifacts', () => {
  it('writes a screenshot under the attempt directory and returns a relative path', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const relative = await session.artifacts.screenshot('home', context().operation);
    expect(relative).toBe('home-1.png');
    expect(readFileSync(path.join(artifactsDir, relative)).length).toBeGreaterThan(0);
    await session.close(cleanup);
    await dispose();
  });

  it('records video and finalizes it on close', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    await session.artifacts.startVideo?.(context().operation);
    await session.close(cleanup);
    const records = daemon.calls.filter((call) => call.command === 'record');
    expect(records.map((call) => call.positionals[0])).toEqual(['start', 'stop']);
    await dispose();
  });

  it('does not offer trace, which mobile-0.1 does not define', async () => {
    const daemon = createFakeDaemon();
    const { session, dispose } = await launch(daemon);
    expect(session.artifacts.startTrace).toBeUndefined();
    expect(session.artifacts.stopTrace).toBeUndefined();
    await session.close(cleanup);
    await dispose();
  });
});

describe('capabilities', () => {
  it('offers no web capability and no state capture', async () => {
    const daemon = createFakeDaemon();
    const { session, dispose } = await launch(daemon);
    expect(session.web).toBeUndefined();
    expect(session.captureState).toBeUndefined();
    expect(session.restoreState).toBeUndefined();
    await session.close(cleanup);
    await dispose();
  });

  it('exposes device controls scoped to the target app', async () => {
    const daemon = createFakeDaemon();
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    await session.device?.home(op);
    await session.device?.setPermission('camera', 'allow', op);
    await session.device?.pushNotification({ aps: { alert: 'Hi' } }, op);
    const permission = daemon.calls.find((call) => call.positionals[0] === 'permission');
    expect(permission?.positionals).toEqual(['permission', 'grant', 'camera']);
    const push = daemon.calls.find((call) => call.command === 'push');
    expect(push?.positionals[0]).toBe('com.example.app');
    expect(JSON.parse(String(push?.positionals[1]))).toEqual({ aps: { alert: 'Hi' } });
    await session.close(cleanup);
    await dispose();
  });
});

describe('lifecycle', () => {
  it('is idempotent on close and rejects use afterwards', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    await session.close(cleanup);
    await session.close(cleanup);
    await expect(session.observe(context().operation)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await dispose();
  });

  it('honors an already-aborted operation', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.observe({ ...context().operation, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await session.close(cleanup);
    await dispose();
  });

  it('rolls back the lease when launch fails', async () => {
    const daemon = createFakeDaemon({
      failAlways: { boot: { code: 'DEVICE_IN_USE', message: 'busy' } },
    });
    const driver = agentDevice({ transport: daemon.transport });
    await expect(driver.launch(context())).rejects.toBeInstanceOf(DriverError);
    // The rollback closed the session it had opened.
    expect(daemon.commands()).toContain('close');
  });

  it('reports resolved device provenance from runtime', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const runtime = await session.runtime(context().operation);
    expect(runtime.device).toEqual({ name: 'iPhone 16', os: 'unknown' });
    expect(runtime.browser).toBeUndefined();
    await session.close(cleanup);
    await dispose();
  });
});

describe('key presses', () => {
  it('sends a control character for a named key, not the key name', async () => {
    // Typing "Enter" would insert that word into the field and report success.
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    await session.actions.press('Enter', context().operation);
    const typed = daemon.calls.find((call) => call.command === 'type');
    expect(typed?.positionals[0]).toBe('\r');
    await session.close(cleanup);
    await dispose();
  });

  it('passes a printable key through as itself', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    await session.actions.press('a', context().operation);
    expect(daemon.calls.find((call) => call.command === 'type')?.positionals[0]).toBe('a');
    await session.close(cleanup);
    await dispose();
  });

  it('rejects a key the platform cannot express instead of typing its name', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    await expect(session.actions.press('F13', context().operation)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect(daemon.commands()).not.toContain('type');
    await session.close(cleanup);
    await dispose();
  });
});

describe('settling', () => {
  it('folds a settle wait into a tap, in the same round trip', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    const refs = await session.screen.resolve(
      { kind: 'query', query: { kind: 'label', value: { kind: 'string', value: 'Continue', exact: true } } },
      op,
    );
    await session.screen.perform(refs[0]!, { kind: 'tap' }, op);
    const click = daemon.calls.find((call) => call.command === 'click');
    expect(click?.flags['settle']).toBe(true);
    await session.close(cleanup);
    await dispose();
  });

  it('waits for quiet after navigation, which cannot fold it in', async () => {
    const daemon = createFakeDaemon({ screen: () => LOGIN_SCREEN });
    const { session, dispose } = await launch(daemon);
    const op = context().operation;
    await session.app.back(op);
    const waits = daemon.calls.filter((call) => call.command === 'wait');
    expect(waits.at(-1)?.positionals[0]).toBe('stable');
    await session.close(cleanup);
    await dispose();
  });

  it('never fails an already committed action because settling failed', async () => {
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      failAlways: { wait: { code: 'COMMAND_FAILED', message: 'never went quiet' } },
    });
    const { session, dispose } = await launch(daemon);
    await session.app.back(context().operation);
    await session.close(cleanup);
    await dispose();
  });
});

describe('abandoned session reclamation', () => {
  /** A session name from a process that no longer exists. */
  const deadPid = 2_147_480_000;

  it('closes a session left behind by a dead run of the same prefix', async () => {
    // The daemon outlives the runner, so a cancelled run keeps its device
    // claimed and every later run fails DEVICE_IN_USE.
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      sessions: [{ name: `e2e-${deadPid}-abc123` }],
    });
    const driver = agentDevice({ transport: daemon.transport });
    const session = await driver.launch(context());
    const reclaimed = daemon.calls
      .filter((call) => call.command === 'close')
      .map((call) => call.flags['session']);
    expect(reclaimed).toContain(`e2e-${deadPid}-abc123`);
    await session.close(cleanup);
    await driver.dispose?.();
  });

  it('leaves a live worker session and a foreign session alone', async () => {
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      sessions: [
        // This process is alive: a parallel worker's device must not be taken.
        { name: `e2e-${process.pid}-live01` },
        // Another tool's session, which is none of our business.
        { name: 'qa-ios' },
      ],
    });
    const driver = agentDevice({ transport: daemon.transport });
    const session = await driver.launch(context());
    const closedNames = daemon.calls
      .filter((call) => call.command === 'close')
      .map((call) => call.flags['session']);
    expect(closedNames).not.toContain(`e2e-${process.pid}-live01`);
    expect(closedNames).not.toContain('qa-ios');
    await session.close(cleanup);
    await driver.dispose?.();
  });

  it('can be turned off', async () => {
    const daemon = createFakeDaemon({
      screen: () => LOGIN_SCREEN,
      sessions: [{ name: `e2e-${deadPid}-abc123` }],
    });
    const driver = agentDevice({ transport: daemon.transport, reclaimAbandonedSessions: false });
    const session = await driver.launch(context());
    expect(daemon.commands()).not.toContain('session_list');
    await session.close(cleanup);
    await driver.dispose?.();
  });
});
