/**
 * The agent-device backend through the public contract, with a scripted
 * client: lifecycle order, the command each contract member issues, id
 * staleness, the path anchor, artifacts, and the contributed fixture. No
 * simulator: what is asserted is the command stream, which is the whole of
 * what this backend owes agent-device.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from 'agent-device';
import type { BackendFixtureContext, BackendHandle, OperationContext, SemanticNode } from 'e2e/backend';
import { buildBackend } from '../../src/backend.ts';
import type { Device } from '../../src/device.ts';
import { AgentDeviceSurface, type AgentDeviceOptions } from '../../src/surface.ts';
import { createFakeClient, SETTINGS_SNAPSHOT, type FakeClient } from '../helpers/fake-client.ts';

function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1' };
}

function cleanup() {
  return { signal: new AbortController().signal, timeoutMs: 5_000 };
}

async function boot(backend: BackendHandle, targetName = 'ios-simulator'): Promise<void> {
  await backend.init!({
    runId: 'run-1',
    targetName,
    app: { allowedOrigins: [] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
}

interface Harness {
  readonly backend: BackendHandle;
  readonly fake: FakeClient;
  readonly sessions: string[];
  readonly surface: AgentDeviceSurface;
}

/** A backend over the scripted client; `pinned` false leaves the `app` option out. */
function harness(options: Partial<AgentDeviceOptions> = {}, pinned = true): Harness {
  const fake = createFakeClient({
    'capture.snapshot': () => SETTINGS_SNAPSHOT,
    'apps.open': () => ({ session: 's', appName: 'Settings', appBundleId: 'com.apple.Preferences', identifiers: {} }),
  });
  const sessions: string[] = [];
  const base: AgentDeviceOptions = pinned ? { platform: 'ios', app: 'Settings' } : { platform: 'ios' };
  const surface = new AgentDeviceSurface({ ...base, ...options }, (session) => {
    sessions.push(session);
    return fake.client;
  });
  return { backend: buildBackend(surface), fake, sessions, surface };
}

let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-agent-device-'));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

async function openAttempt(h: Harness, attemptId = 'a1'): Promise<void> {
  await boot(h.backend);
  await h.backend.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
}

/** The observed node with this name, from a fresh observation. */
async function observed(h: Harness, name: string): Promise<SemanticNode> {
  const snapshot = await h.backend.observe!(operation());
  return named(snapshot.nodes, name);
}

function named(nodes: readonly SemanticNode[], name: string): SemanticNode {
  const found = [...walk(nodes)].find((node) => node.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

function* walk(nodes: readonly SemanticNode[]): Generator<SemanticNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children ?? []);
  }
}

describe('manifest', () => {
  it('declares observation, actions, location, artifacts, the device fixture, and app hooks by option', () => {
    const pinned = harness().backend;
    expect([...pinned.capabilities].toSorted()).toEqual(['actions', 'artifacts', 'device', 'location', 'observation']);
    expect(pinned.name).toBe('agent-device');
    expect(pinned.version).not.toBe('unknown');
    expect(Object.keys(pinned.app!).toSorted()).toEqual(['back', 'clearState', 'restart']);
    expect(pinned.url).toBeDefined();
    expect(pinned.state).toBeUndefined();

    const free = harness({}, false).backend;
    expect(Object.keys(free.app!)).toEqual(['back']);
  });
});

describe('lifecycle', () => {
  it('boots once per init under a session named after the target, opens the app fresh per attempt, and closes on dispose', async () => {
    const h = harness();
    await openAttempt(h);
    expect(h.sessions).toEqual(['e2e-ios-simulator']);
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.open']);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios' });
    expect(h.fake.lastArgs('apps.open')).toEqual({ app: 'Settings', platform: 'ios', relaunch: true });

    await h.backend.endAttempt!(cleanup());
    await h.backend.endAttempt!(cleanup());
    await h.backend.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(h.fake.methods().filter((m) => m === 'apps.open')).toHaveLength(2);

    await h.backend.dispose!(cleanup());
    expect(h.fake.methods().at(-1)).toBe('sessions.close');
    await h.backend.dispose!(cleanup());
    expect(h.fake.methods().filter((m) => m === 'sessions.close')).toHaveLength(1);

    // A disposed handle boots again: the config-held handle outlives a worker.
    await boot(h.backend, 'second');
    expect(h.sessions).toEqual(['e2e-ios-simulator', 'e2e-second']);
  });

  it('honours an explicit session and device, and does not open anything without a pinned app', async () => {
    const h = harness({ session: 'qa-run', device: 'iPhone 16e' }, false);
    await openAttempt(h);
    expect(h.sessions).toEqual(['qa-run']);
    expect(h.fake.methods()).toEqual(['devices.boot']);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 16e' });
  });

  it('refuses a second startAttempt while one runs and treats cold cleanup as a no-op', async () => {
    const h = harness();
    await expect(h.backend.endAttempt!(cleanup())).resolves.toBeUndefined();
    await expect(h.backend.dispose!(cleanup())).resolves.toBeUndefined();
    await openAttempt(h);
    await expect(
      h.backend.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('gives up on a session close that outlives the cleanup budget', async () => {
    const h = harness();
    h.fake.respond('sessions.close', () => new Promise(() => undefined));
    await openAttempt(h);
    const exhausted = new AbortController();
    exhausted.abort();
    await expect(h.backend.dispose!({ signal: exhausted.signal, timeoutMs: 0 })).resolves.toBeUndefined();
  });

  it('reports a boot failure as BACKEND_FAILURE with the agent-device message', async () => {
    const h = harness();
    h.fake.respond('devices.boot', () => {
      throw new AppError('DEVICE_NOT_FOUND', 'no booted iOS simulator');
    });
    await expect(boot(h.backend)).rejects.toMatchObject({
      code: 'BACKEND_FAILURE',
      message: 'boot failed: no booted iOS simulator',
    });
  });
});

describe('observation', () => {
  it('projects the snapshot with a viewport and a fresh id generation each time', async () => {
    const h = harness();
    await openAttempt(h);
    const first = await h.backend.observe!(operation());
    expect(first.viewport).toEqual({ width: 390, height: 844, scale: 1 });
    expect(first.nodes).toHaveLength(1);
    expect(h.fake.lastArgs('capture.snapshot')).toEqual({ interactiveOnly: false });
    const about = [...walk(first.nodes)].find((node) => node.name === 'About')!;

    const second = await h.backend.observe!(operation());
    const aboutAgain = [...walk(second.nodes)].find((node) => node.name === 'About')!;
    expect(aboutAgain.ref.id).not.toBe(about.ref.id);
    await expect(h.backend.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
  });

  it('asks for interactive-only snapshots when configured', async () => {
    const h = harness({ snapshot: 'interactive' });
    await openAttempt(h);
    await h.backend.observe!(operation());
    expect(h.fake.lastArgs('capture.snapshot')).toEqual({ interactiveOnly: true });
  });

  it('retries a sparse snapshot device-side before returning it', async () => {
    const h = harness();
    let calls = 0;
    h.fake.respond('capture.snapshot', () => {
      calls += 1;
      return calls < 2 ? { nodes: [{ ref: '@e1', type: 'application' }], snapshotQuality: { state: 'sparse' } } : SETTINGS_SNAPSHOT;
    });
    await openAttempt(h);
    const snapshot = await h.backend.observe!(operation());
    expect(calls).toBe(2);
    expect([...walk(snapshot.nodes)]).toHaveLength(10);
  });

  it('is an empty screen before any app is open when no app is pinned, and a fault when one is', async () => {
    const free = harness({}, false);
    free.fake.respond('capture.snapshot', () => {
      throw new AppError('SESSION_NOT_FOUND', 'No active app session');
    });
    await openAttempt(free);
    expect(await free.backend.observe!(operation())).toEqual({ nodes: [] });

    const pinned = harness();
    pinned.fake.respond('capture.snapshot', () => {
      throw new AppError('SESSION_NOT_FOUND', 'No active app session');
    });
    await openAttempt(pinned);
    await expect(pinned.backend.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('captures pixels on request, reports no masked regions, and degrades to tree-only when the shot fails', async () => {
    const h = harness();
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 1170);
    new DataView(png.buffer).setUint32(20, 2532);
    h.fake.respond('capture.screenshot', (args) => {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync((args as { path: string }).path, png);
      return { path: (args as { path: string }).path };
    });
    await openAttempt(h);
    const snapshot = await h.backend.observe!(operation(), { pixels: true });
    expect(snapshot.pixels).toMatchObject({ mediaType: 'image/png', width: 1170, height: 2532, scale: 3 });
    expect(snapshot.maskedRegionCount).toBe(0);

    h.fake.respond('capture.screenshot', () => {
      throw new AppError('COMMAND_FAILED', 'screenshot failed');
    });
    const treeOnly = await h.backend.observe!(operation(), { pixels: true });
    expect(treeOnly.pixels).toBeUndefined();
    expect(treeOnly.nodes).toHaveLength(1);
  });

  it('cancels a snapshot when the operation aborts', async () => {
    const h = harness();
    h.fake.respond('capture.snapshot', () => new Promise(() => undefined));
    await openAttempt(h);
    const controller = new AbortController();
    const pending = h.backend.observe!(operation(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('location', () => {
  it('locates against a fresh snapshot and keeps observation ids valid', async () => {
    const h = harness();
    await openAttempt(h);
    const about = await observed(h, 'About');
    const [back] = await h.backend.locate!(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      operation(),
    );
    expect(back?.name).toBe('Back');
    await h.backend.perform!(back!.ref, { kind: 'tap' }, operation());
    await h.backend.perform!(about.ref, { kind: 'tap' }, operation());
    expect(h.fake.calls.filter((call) => call.method === 'interactions.press').map((call) => call.args)).toEqual([
      { ref: '@e3', settle: true },
      { ref: '@e4', settle: true },
    ]);
  });
});

describe('perform', () => {
  it('maps every supported action onto one agent-device command', async () => {
    const h = harness();
    await openAttempt(h);
    const op = operation();
    const { nodes } = await h.backend.observe!(op);
    const [about, toggle, search, scroller, back] = ['About', 'Airplane Mode', 'Search', 'Scroller', 'Back'].map((name) =>
      named(nodes, name),
    );
    const before = h.fake.calls.length;
    await h.backend.perform!(about!.ref, { kind: 'tap' }, op);
    await h.backend.perform!(about!.ref, { kind: 'doubleTap' }, op);
    await h.backend.perform!(about!.ref, { kind: 'longPress', durationMs: 900 }, op);
    await h.backend.perform!(about!.ref, { kind: 'focus' }, op);
    await h.backend.perform!(about!.ref, { kind: 'hover' }, op);
    await h.backend.perform!(search!.ref, { kind: 'fill', value: 'blue', sensitive: false }, op);
    await h.backend.perform!(search!.ref, { kind: 'clear' }, op);
    await h.backend.perform!(toggle!.ref, { kind: 'uncheck' }, op);
    await h.backend.perform!(toggle!.ref, { kind: 'check' }, op);
    await h.backend.perform!(search!.ref, { kind: 'press', key: 'Enter' }, op);
    await h.backend.perform!(search!.ref, { kind: 'press', key: 'a' }, op);
    await h.backend.perform!(scroller!.ref, { kind: 'swipe', direction: 'down' }, op);
    await h.backend.perform!(about!.ref, { kind: 'dragTo', target: back!.ref }, op);
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['interactions.press', { ref: '@e4', settle: true }],
      ['interactions.press', { ref: '@e4', doubleTap: true, settle: true }],
      ['interactions.longPress', { ref: '@e4', settle: true, durationMs: 900 }],
      ['interactions.press', { ref: '@e4', settle: true }],
      ['interactions.hover', { ref: '@e4' }],
      ['interactions.fill', { ref: '@e7', text: 'blue', settle: true }],
      ['interactions.fill', { ref: '@e7', text: '', settle: true }],
      ['interactions.press', { ref: '@e6', settle: true }],
      ['command.keyboard', { action: 'enter' }],
      ['interactions.press', { ref: '@e7', settle: true }],
      ['interactions.type', { text: 'a' }],
      ['interactions.swipe', { from: { x: 195, y: 620 }, to: { x: 195, y: 420 } }],
      ['interactions.drag', { source: '@e4', destination: '@e3' }],
    ]);
  });

  it('presses the innermost control of a row-spanning switch, and the node itself when it has none', async () => {
    const h = harness();
    h.fake.respond('capture.snapshot', () => ({
      nodes: [
        { ref: 'e1', index: 0, depth: 0, type: 'Application' },
        { ref: 'e2', index: 1, parentIndex: 0, depth: 1, type: 'Switch', label: 'Haptic Feedback', value: '1' },
        { ref: 'e3', index: 2, parentIndex: 1, depth: 2, type: 'Button', label: 'Haptic Feedback' },
        { ref: 'e4', index: 3, parentIndex: 1, depth: 2, type: 'Switch', value: '1' },
        { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'Switch', label: 'Sound', value: '0' },
      ],
    }));
    await openAttempt(h);
    const { nodes } = await h.backend.observe!(operation());
    const haptic = named(nodes, 'Haptic Feedback');
    const sound = named(nodes, 'Sound');
    const before = h.fake.calls.length;
    await h.backend.perform!(haptic.ref, { kind: 'uncheck' }, operation());
    await h.backend.perform!(haptic.ref, { kind: 'tap' }, operation());
    await h.backend.perform!(sound.ref, { kind: 'check' }, operation());
    await h.backend.perform!(haptic.ref, { kind: 'check' }, operation());
    // Through the location tier too: a located switch still knows its control.
    const [located] = await h.backend.locate!(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'switch', exact: true }, name: { kind: 'string', value: 'Haptic Feedback', exact: true } } },
      operation(),
    );
    await h.backend.perform!(located!.ref, { kind: 'uncheck' }, operation());
    expect(h.fake.calls.slice(before).filter((call) => call.method === 'interactions.press').map((call) => call.args)).toEqual([
      { ref: '@e4', settle: true },
      { ref: '@e4', settle: true },
      { ref: '@e5', settle: true },
      { ref: '@e4', settle: true },
    ]);
  });

  it('refuses what a device surface cannot express, and reports daemon ref misses as retryable', async () => {
    const h = harness();
    await openAttempt(h);
    const about = await observed(h, 'About');
    for (const action of [
      { kind: 'selectOption', value: 'x' },
      { kind: 'setInputFiles', paths: ['/tmp/x'] },
      { kind: 'scrollIntoView' },
      { kind: 'press', key: 'Escape' },
    ] as const) {
      await expect(h.backend.perform!(about.ref, action, operation())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
      });
    }
    h.fake.respond('interactions.press', () => {
      throw new AppError('INVALID_ARGS', 'ref @e4 not found; take a new snapshot');
    });
    await expect(h.backend.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
    h.fake.respond('interactions.press', () => {
      throw new AppError('COMMAND_FAILED', 'XCTest lost the runner');
    });
    await expect(h.backend.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'BACKEND_FAILURE',
      retryable: false,
    });
  });
});

describe('app hooks, swipe, url, artifacts', () => {
  it('scrolls the viewport, goes back, relaunches, and clears state through the pinned app', async () => {
    const h = harness();
    await openAttempt(h);
    const before = h.fake.calls.length;
    await h.backend.swipe!('down', 'fast', operation());
    await h.backend.app!.back!(operation());
    await h.backend.app!.restart!(operation());
    await h.backend.app!.clearState!(operation());
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['interactions.scroll', { direction: 'down' }],
      ['command.back', { settle: true }],
      ['apps.open', { app: 'Settings', platform: 'ios', relaunch: true }],
      ['settings.update', { setting: 'clear-app-state', state: 'clear', app: 'Settings' }],
      ['apps.open', { app: 'Settings', platform: 'ios', relaunch: true }],
    ]);
  });

  it('anchors the path on the foreground app and the screen title', async () => {
    const h = harness();
    await openAttempt(h);
    expect(await h.backend.url!(operation())).toBe('app://com.apple.preferences/General');
    h.fake.respond('capture.snapshot', () => ({ nodes: [{ ref: '@e1', type: 'button', label: 'Go' }] }));
    expect(await h.backend.url!(operation())).toBe('app://com.apple.preferences/');
    const cold = harness({}, false);
    await openAttempt(cold);
    cold.fake.respond('capture.snapshot', () => ({ nodes: [{ ref: '@e1', type: 'button' }] }));
    expect(await cold.backend.url!(operation())).toBe('app://app/');
  });

  it('numbers screenshots per attempt under the artifact directory', async () => {
    const h = harness();
    await openAttempt(h);
    expect(await h.backend.artifacts!.screenshot('first shot', operation())).toBe('screenshots/001-first_shot.png');
    expect(await h.backend.artifacts!.screenshot(undefined, operation())).toBe('screenshots/002-screenshot.png');
    expect(h.fake.lastArgs('capture.screenshot')).toEqual({
      path: path.join(artifactsDir, 'screenshots', '002-screenshot.png'),
    });
    await h.backend.endAttempt!(cleanup());
    await h.backend.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(await h.backend.artifacts!.screenshot('again', operation())).toBe('screenshots/001-again.png');
  });
});

describe('device fixture', () => {
  const minted: unknown[] = [];
  function fixture(h: Harness): Device {
    const context = {
      targetName: 'ios-simulator',
      signal: new AbortController().signal,
      locator: (expression: unknown) => {
        minted.push(expression);
        return { minted: true };
      },
    } as unknown as BackendFixtureContext;
    return h.backend.fixtures!['device']!(context) as Device;
  }

  it('mints a core locator from an agent-device selector without a device round trip', async () => {
    const h = harness();
    await openAttempt(h);
    const before = h.fake.calls.length;
    expect(fixture(h).locator('id=About')).toEqual({ minted: true });
    expect(minted).toEqual([{ kind: 'selector', selector: 'id=About' }]);
    expect(h.fake.calls.length).toBe(before);
  });

  it('issues one settings or system command per method', async () => {
    const h = harness();
    await openAttempt(h);
    h.fake.respond('command.appState', () => ({ platform: 'ios', appName: 'Settings', appBundleId: 'com.apple.Preferences' }));
    h.fake.respond('command.clipboard', (args) =>
      (args as { action: string }).action === 'read' ? { action: 'read', text: 'pasted' } : { action: 'write', textLength: 1 },
    );
    const device = fixture(h);
    const before = h.fake.calls.length;
    await device.setNetwork('offline');
    await device.setAirplaneMode(true);
    await device.setPermission('camera', 'grant');
    await device.setLocation({ latitude: 37.3349, longitude: -122.009 });
    await device.clearLocation();
    await device.setAppearance('dark');
    await device.setOrientation('landscape-left');
    await device.setBiometrics('faceid', 'match');
    await device.setBiometrics('fingerprint', 'nonmatch');
    await device.enrollBiometrics('touchid', true);
    await device.openApp('Reminders', { relaunch: true });
    await device.closeApp();
    expect(await device.foregroundApp()).toEqual({ name: 'Settings', bundleId: 'com.apple.Preferences' });
    await device.home();
    await device.back();
    await device.alert('accept');
    await device.dismissKeyboard();
    expect(await device.clipboard()).toBe('pasted');
    await device.setClipboard('x');
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['settings.update', { setting: 'wifi', state: 'off' }],
      ['settings.update', { setting: 'airplane', state: 'on' }],
      ['settings.update', { setting: 'permission', permission: 'camera', state: 'grant' }],
      ['settings.update', { setting: 'location', state: 'set', latitude: 37.3349, longitude: -122.009 }],
      ['settings.update', { setting: 'location', state: 'off' }],
      ['settings.update', { setting: 'appearance', state: 'dark' }],
      ['command.orientation', { orientation: 'landscape-left' }],
      ['settings.update', { setting: 'faceid', state: 'match' }],
      ['settings.update', { setting: 'fingerprint', state: 'nonmatch' }],
      ['settings.update', { setting: 'touchid', state: 'enroll' }],
      ['apps.open', { app: 'Reminders', platform: 'ios', relaunch: true }],
      ['apps.close', {}],
      ['command.appState', {}],
      ['command.home', {}],
      ['command.back', { settle: true }],
      ['command.alert', { action: 'accept' }],
      ['command.keyboard', { action: 'dismiss' }],
      ['command.clipboard', { action: 'read' }],
      ['command.clipboard', { action: 'write', text: 'x' }],
    ]);
  });

  it('reads an Android foreground package', async () => {
    const h = harness({ platform: 'android', app: 'com.android.settings' });
    await openAttempt(h);
    h.fake.respond('command.appState', () => ({ platform: 'android', package: 'com.android.settings', activity: '.Main' }));
    expect(await fixture(h).foregroundApp()).toEqual({ name: 'com.android.settings', bundleId: 'com.android.settings' });
  });
});
