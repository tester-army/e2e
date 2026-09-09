/**
 * The agent-device engine through the public contract, with a scripted
 * client: lifecycle order, the command each contract member issues, id
 * staleness, the path anchor, artifacts, and the contributed fixture. No
 * simulator: what is asserted is the command stream, which is the whole of
 * what this engine owes agent-device.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from 'agent-device';
import { decodePng, encodePng } from '../helpers/png.ts';
import type { EngineFixtureContext, EngineHandle, OperationContext, SemanticNode } from '@e2edev/e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import type { Device } from '../../src/device.ts';
import { AgentDeviceSurface, type AgentDeviceOptions } from '../../src/surface.ts';
import { createFakeClient, SETTINGS_SNAPSHOT, type FakeClient } from '../helpers/fake-client.ts';

/** Deliberately not `process.cwd()`: relative build paths must resolve here, not there. */
const PROJECT_ROOT = '/project';

function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1' };
}

function cleanup() {
  return { signal: new AbortController().signal, timeoutMs: 5_000 };
}

async function boot(engine: EngineHandle, targetName = 'ios-simulator'): Promise<void> {
  await engine.init!({
    runId: 'run-1',
    targetName,
    projectRoot: PROJECT_ROOT,
    app: { allowedOrigins: [] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal: new AbortController().signal,
  });
}

interface Harness {
  readonly engine: EngineHandle;
  readonly fake: FakeClient;
  readonly sessions: string[];
  readonly surface: AgentDeviceSurface;
}

/** An engine over the scripted client; `pinned` false leaves the `app` option out. */
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
  return { engine: buildEngine(surface), fake, sessions, surface };
}

let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-agent-device-'));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

async function openAttempt(h: Harness, attemptId = 'a1'): Promise<void> {
  await boot(h.engine);
  await h.engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal });
}

/** The observed node with this name, from a fresh observation. */
async function observed(h: Harness, name: string): Promise<SemanticNode> {
  const snapshot = await h.engine.observe!(operation());
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
    const pinned = harness().engine;
    expect([...pinned.capabilities].toSorted()).toEqual(['actions', 'artifacts', 'device', 'location', 'observation']);
    expect(pinned.name).toBe('agent-device');
    expect(pinned.version).not.toBe('unknown');
    expect(Object.keys(pinned.app!).toSorted()).toEqual(['back', 'clearState', 'identity', 'restart']);
    expect(pinned.app!.identity).toBe('Settings');
    expect(pinned.url).toBeDefined();
    expect(pinned.state).toBeUndefined();

    const free = harness({}, false).engine;
    expect(Object.keys(free.app!)).toEqual(['back']);
  });

  it('declares the app identity from the option, the build path, or an explicit identity', () => {
    expect(harness({ appPath: './build/App.app' }, false).engine.app).toMatchObject({ identity: './build/App.app' });
    expect(harness({ identity: 'com.example.app', environment: 'staging' }).engine.app).toMatchObject({
      identity: 'com.example.app',
      environment: 'staging',
    });
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

    await h.engine.endAttempt!(cleanup());
    await h.engine.endAttempt!(cleanup());
    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(h.fake.methods().filter((m) => m === 'apps.open')).toHaveLength(2);

    await h.engine.dispose!(cleanup());
    expect(h.fake.methods().at(-1)).toBe('sessions.close');
    await h.engine.dispose!(cleanup());
    expect(h.fake.methods().filter((m) => m === 'sessions.close')).toHaveLength(1);

    // A disposed handle boots again: the config-held handle outlives a worker.
    await boot(h.engine, 'second');
    expect(h.sessions).toEqual(['e2e-ios-simulator', 'e2e-second']);
  });

  it('honours an explicit session and device, and does not open anything without a pinned app', async () => {
    const h = harness({ session: 'qa-run', device: 'iPhone 16e' }, false);
    await openAttempt(h);
    expect(h.sessions).toEqual(['qa-run']);
    expect(h.fake.methods()).toEqual(['devices.boot']);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 16e' });
  });

  it('takes undefined for every optional option, so env-driven configs need no conditional spreads', async () => {
    const h = harness(
      { app: undefined, appPath: undefined, identity: undefined, environment: undefined, device: undefined, session: undefined, snapshot: undefined },
      false,
    );
    expect(Object.keys(h.engine.app!)).toEqual(['back']);
    await openAttempt(h);
    expect(h.sessions).toEqual(['e2e-ios-simulator']);
    expect(h.fake.methods()).toEqual(['devices.boot']);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios' });
  });

  it('installs the build once per init and opens what it installed when no app is pinned', async () => {
    const h = harness({ appPath: './build/App.app' }, false);
    h.fake.respond('apps.install', () => ({
      app: './build/App.app',
      appPath: '/project/build/App.app',
      platform: 'ios',
      bundleId: 'com.example.app',
      identifiers: {},
    }));
    expect(Object.keys(h.engine.app!).toSorted()).toEqual(['back', 'clearState', 'identity', 'restart']);
    await openAttempt(h);
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.install', 'apps.open']);
    expect(h.fake.lastArgs('apps.install')).toEqual({ platform: 'ios', appPath: '/project/build/App.app' });
    expect(h.fake.lastArgs('apps.open')).toEqual({ app: 'com.example.app', platform: 'ios', relaunch: true });

    await h.engine.endAttempt!(cleanup());
    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(h.fake.methods().filter((m) => m === 'apps.install')).toHaveLength(1);

    await h.engine.app!.clearState!(operation());
    expect(h.fake.lastArgs('settings.update')).toEqual({ setting: 'clear-app-state', state: 'clear', app: 'com.example.app' });

    // A new worker installs again: the build on the device is the worker's.
    await h.engine.dispose!(cleanup());
    await openAttempt(h);
    expect(h.fake.methods().filter((m) => m === 'apps.install')).toHaveLength(2);
  });

  it('installs under the pinned app and device, and keeps opening the pinned app', async () => {
    const h = harness({ app: 'com.example.app', appPath: '/builds/app.apk', device: 'Pixel 8', platform: 'android' });
    h.fake.respond('apps.install', () => ({ app: 'com.example.app', appPath: '/builds/app.apk', platform: 'android', identifiers: {} }));
    await openAttempt(h);
    expect(h.fake.lastArgs('apps.install')).toEqual({
      platform: 'android',
      device: 'Pixel 8',
      app: 'com.example.app',
      appPath: '/builds/app.apk',
    });
    expect(h.fake.lastArgs('apps.open')).toEqual({ app: 'com.example.app', platform: 'android', device: 'Pixel 8', relaunch: true });
  });

  it('fails init when the install fails, before anything is opened', async () => {
    const h = harness({ appPath: './missing.app' }, false);
    h.fake.respond('apps.install', () => {
      throw new Error('no such file: missing.app');
    });
    await expect(openAttempt(h)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.install']);
  });

  it('refuses a second startAttempt while one runs and treats cold cleanup as a no-op', async () => {
    const h = harness();
    await expect(h.engine.endAttempt!(cleanup())).resolves.toBeUndefined();
    await expect(h.engine.dispose!(cleanup())).resolves.toBeUndefined();
    await openAttempt(h);
    await expect(
      h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('gives up on a session close that outlives the cleanup budget', async () => {
    const h = harness();
    h.fake.respond('sessions.close', () => new Promise(() => undefined));
    await openAttempt(h);
    const exhausted = new AbortController();
    exhausted.abort();
    await expect(h.engine.dispose!({ signal: exhausted.signal, timeoutMs: 0 })).resolves.toBeUndefined();
  });

  it('reports a boot failure as ENGINE_FAILURE with the agent-device message', async () => {
    const h = harness();
    h.fake.respond('devices.boot', () => {
      throw new AppError('DEVICE_NOT_FOUND', 'no booted iOS simulator');
    });
    await expect(boot(h.engine)).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'boot failed: no booted iOS simulator',
    });
  });
});

describe('observation', () => {
  it('projects the snapshot with a viewport and a fresh id generation each time', async () => {
    const h = harness();
    await openAttempt(h);
    const first = await h.engine.observe!(operation());
    expect(first.viewport).toEqual({ width: 390, height: 844, scale: 1 });
    expect(first.nodes).toHaveLength(1);
    expect(h.fake.lastArgs('capture.snapshot')).toEqual({ interactiveOnly: false });
    const about = [...walk(first.nodes)].find((node) => node.name === 'About')!;

    const second = await h.engine.observe!(operation());
    const aboutAgain = [...walk(second.nodes)].find((node) => node.name === 'About')!;
    expect(aboutAgain.ref.id).not.toBe(about.ref.id);
    await expect(h.engine.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
  });

  it('asks for interactive-only snapshots when configured', async () => {
    const h = harness({ snapshot: 'interactive' });
    await openAttempt(h);
    await h.engine.observe!(operation());
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
    const snapshot = await h.engine.observe!(operation());
    expect(calls).toBe(2);
    expect([...walk(snapshot.nodes)]).toHaveLength(10);
  });

  it('is an empty screen before any app is open when no app is pinned, and a fault when one is', async () => {
    const free = harness({}, false);
    free.fake.respond('capture.snapshot', () => {
      throw new AppError('SESSION_NOT_FOUND', 'No active app session');
    });
    await openAttempt(free);
    expect(await free.engine.observe!(operation())).toEqual({ nodes: [] });

    const pinned = harness();
    pinned.fake.respond('capture.snapshot', () => {
      throw new AppError('SESSION_NOT_FOUND', 'No active app session');
    });
    await openAttempt(pinned);
    await expect(pinned.engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('captures pixels on request, masks every secure node, and degrades to tree-only when it cannot', async () => {
    const h = harness();
    // 390x844 viewport at 3x: a white RGBA image of the device's size.
    const image = { width: 1170, height: 2532, channels: 4 as const, pixels: new Uint8Array(1170 * 2532 * 4).fill(255) };
    const png = encodePng(image);
    h.fake.respond('capture.screenshot', (args) => {
      writeFileSync((args as { path: string }).path, png);
      return { path: (args as { path: string }).path };
    });
    await openAttempt(h);
    const snapshot = await h.engine.observe!(operation(), { pixels: true });
    expect(snapshot.pixels).toMatchObject({ mediaType: 'image/png', width: 1170, height: 2532, scale: 3 });
    // One secure node on the Settings fixture: the Password field at y=270, 44 tall.
    expect(snapshot.maskedRegionCount).toBe(1);
    const decoded = decodePng(snapshot.pixels!.data);
    const at = (x: number, y: number) => [...decoded.pixels.subarray((y * 1170 + x) * 4, (y * 1170 + x) * 4 + 3)];
    expect(at(600, 290 * 3)).toEqual([0, 0, 0]);
    expect(at(600, 240 * 3)).toEqual([255, 255, 255]);

    // A secure node without bounds cannot be masked: the tree ships, the image does not.
    h.fake.respond('capture.snapshot', () => ({
      nodes: [{ ref: 'e1', type: 'SecureTextField', label: 'PIN', value: '1234' }],
    }));
    const unmaskable = await h.engine.observe!(operation(), { pixels: true });
    expect(unmaskable.pixels).toBeUndefined();
    expect(unmaskable.nodes).toHaveLength(1);

    h.fake.respond('capture.snapshot', () => SETTINGS_SNAPSHOT);
    h.fake.respond('capture.screenshot', () => {
      throw new AppError('COMMAND_FAILED', 'screenshot failed');
    });
    const treeOnly = await h.engine.observe!(operation(), { pixels: true });
    expect(treeOnly.pixels).toBeUndefined();
    expect(treeOnly.nodes).toHaveLength(1);
  });

  it('cancels a snapshot when the operation aborts', async () => {
    const h = harness();
    h.fake.respond('capture.snapshot', () => new Promise(() => undefined));
    await openAttempt(h);
    const controller = new AbortController();
    const pending = h.engine.observe!(operation(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('location', () => {
  it('locates against a fresh snapshot and keeps observation ids valid', async () => {
    const h = harness();
    await openAttempt(h);
    const about = await observed(h, 'About');
    const [back] = await h.engine.locate!(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } },
      operation(),
    );
    expect(back?.name).toBe('Back');
    await h.engine.perform!(back!.ref, { kind: 'tap' }, operation());
    await h.engine.perform!(about.ref, { kind: 'tap' }, operation());
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
    const { nodes } = await h.engine.observe!(op);
    const [about, toggle, search, scroller, back] = ['About', 'Airplane Mode', 'Search', 'Scroller', 'Back'].map((name) =>
      named(nodes, name),
    );
    const before = h.fake.calls.length;
    await h.engine.perform!(about!.ref, { kind: 'tap' }, op);
    await h.engine.perform!(about!.ref, { kind: 'doubleTap' }, op);
    await h.engine.perform!(about!.ref, { kind: 'longPress', durationMs: 900 }, op);
    await h.engine.perform!(search!.ref, { kind: 'focus' }, op);
    await h.engine.perform!(about!.ref, { kind: 'hover' }, op);
    await h.engine.perform!(search!.ref, { kind: 'fill', value: 'blue', sensitive: false }, op);
    await h.engine.perform!(search!.ref, { kind: 'clear' }, op);
    await h.engine.perform!(toggle!.ref, { kind: 'uncheck' }, op);
    await h.engine.perform!(toggle!.ref, { kind: 'check' }, op);
    await h.engine.perform!(search!.ref, { kind: 'press', key: 'Enter' }, op);
    await h.engine.perform!(search!.ref, { kind: 'press', key: 'a' }, op);
    await h.engine.perform!(scroller!.ref, { kind: 'swipe', direction: 'down' }, op);
    await h.engine.perform!(about!.ref, { kind: 'dragTo', target: back!.ref }, op);
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['interactions.press', { ref: '@e4', settle: true }],
      ['interactions.press', { ref: '@e4', doubleTap: true, settle: true }],
      ['interactions.longPress', { ref: '@e4', settle: true, durationMs: 900 }],
      ['interactions.press', { ref: '@e7', settle: true }],
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

  it.each(['e2', ''])('presses the innermost control even when the row ref is %j', async (rowRef) => {
    const h = harness();
    h.fake.respond('capture.snapshot', () => ({
      nodes: [
        { ref: 'e1', index: 0, depth: 0, type: 'Application' },
        { ref: rowRef, index: 1, parentIndex: 0, depth: 1, type: 'Switch', label: 'Haptic Feedback', value: '1' },
        { ref: 'e3', index: 2, parentIndex: 1, depth: 2, type: 'Button', label: 'Haptic Feedback' },
        { ref: 'e4', index: 3, parentIndex: 1, depth: 2, type: 'Switch', value: '1' },
        { ref: 'e5', index: 4, parentIndex: 0, depth: 1, type: 'Switch', label: 'Sound', value: '0' },
      ],
    }));
    await openAttempt(h);
    const { nodes } = await h.engine.observe!(operation());
    const haptic = named(nodes, 'Haptic Feedback');
    const sound = named(nodes, 'Sound');
    const before = h.fake.calls.length;
    await h.engine.perform!(haptic.ref, { kind: 'uncheck' }, operation());
    await h.engine.perform!(haptic.ref, { kind: 'tap' }, operation());
    await h.engine.perform!(sound.ref, { kind: 'check' }, operation());
    await h.engine.perform!(haptic.ref, { kind: 'check' }, operation());
    // Through the location tier too: a located switch still knows its control.
    const [located] = await h.engine.locate!(
      { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'switch', exact: true }, name: { kind: 'string', value: 'Haptic Feedback', exact: true } } },
      operation(),
    );
    await h.engine.perform!(located!.ref, { kind: 'uncheck' }, operation());
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
      // A tap would activate the row; focus is for editable fields only.
      { kind: 'focus' },
      // The row-level cell exposes no checked state; a blind flip could undo a correct one.
      { kind: 'check' },
    ] as const) {
      await expect(h.engine.perform!(about.ref, action, operation())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
      });
    }
    h.fake.respond('interactions.press', () => {
      throw new AppError('INVALID_ARGS', 'ref @e4 not found; take a new snapshot');
    });
    await expect(h.engine.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NODE_STALE',
      retryable: true,
    });
    h.fake.respond('interactions.press', () => {
      throw new AppError('COMMAND_FAILED', 'XCTest lost the runner');
    });
    await expect(h.engine.perform!(about.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      retryable: false,
    });
  });
});

describe('app hooks, swipe, url, artifacts', () => {
  it('scrolls the viewport, goes back, relaunches, and clears state through the pinned app', async () => {
    const h = harness();
    await openAttempt(h);
    const before = h.fake.calls.length;
    await h.engine.swipe!('down', 'fast', operation());
    await h.engine.app!.back!(operation());
    await h.engine.app!.restart!(operation());
    await h.engine.app!.clearState!(operation());
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
    expect(await h.engine.url!(operation())).toBe('app://device/com.apple.preferences/General');
    h.fake.respond('capture.snapshot', () => ({ nodes: [{ ref: '@e1', type: 'button', label: 'Go' }] }));
    expect(await h.engine.url!(operation())).toBe('app://device/com.apple.preferences/');
    const cold = harness({}, false);
    await openAttempt(cold);
    cold.fake.respond('capture.snapshot', () => ({ nodes: [{ ref: '@e1', type: 'button' }] }));
    expect(await cold.engine.url!(operation())).toBe('app://device/unknown/');
  });

  it('numbers screenshots per attempt, masks secure fields in them, and refuses an unmaskable one', async () => {
    const h = harness();
    const image = { width: 390, height: 844, channels: 3 as const, pixels: new Uint8Array(390 * 844 * 3).fill(200) };
    const temporaryFiles: string[] = [];
    h.fake.respond('capture.screenshot', (args) => {
      const file = (args as { path: string }).path;
      temporaryFiles.push(file);
      writeFileSync(file, encodePng(image));
      return { path: file };
    });
    await openAttempt(h);
    expect(await h.engine.artifacts!.screenshot('first shot', operation())).toBe('screenshots/001-first_shot.png');
    expect(await h.engine.artifacts!.screenshot(undefined, operation())).toBe('screenshots/002-screenshot.png');
    const written = decodePng(new Uint8Array(readFileSync(path.join(artifactsDir, 'screenshots', '002-screenshot.png'))));
    const at = (x: number, y: number) => [...written.pixels.subarray((y * written.width + x) * written.channels, (y * written.width + x) * written.channels + 3)];
    expect(at(100, 290)).toEqual([0, 0, 0]);
    expect(at(100, 240)).toEqual([200, 200, 200]);

    await h.engine.endAttempt!(cleanup());
    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(await h.engine.artifacts!.screenshot('again', operation())).toBe('screenshots/001-again.png');

    h.fake.respond('capture.snapshot', () => ({
      nodes: [{ ref: 'e1', type: 'SecureTextField', label: 'PIN', value: '1234' }],
    }));
    await expect(h.engine.artifacts!.screenshot('leak', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(existsSync(path.join(artifactsDir, 'screenshots', '002-leak.png'))).toBe(false);
    expect(new Set(temporaryFiles).size).toBe(temporaryFiles.length);
    for (const file of temporaryFiles) {
      expect(existsSync(file)).toBe(false);
      expect(existsSync(path.dirname(file))).toBe(false);
    }
  });

  it.each(['capture', 'read'])('removes temporary screenshots after a %s failure', async (failure) => {
    const h = harness();
    let file: string | undefined;
    h.fake.respond('capture.screenshot', (args) => {
      file = (args as { path: string }).path;
      writeFileSync(file, new Uint8Array([1, 2, 3]));
      if (failure === 'capture') throw new AppError('COMMAND_FAILED', 'capture failed after writing');
      return { path: path.join(path.dirname(file), 'missing.png') };
    });
    await openAttempt(h);
    try {
      await expect(h.engine.artifacts!.screenshot('failed', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
      expect(file).toBeDefined();
      expect(existsSync(file!)).toBe(false);
      expect(existsSync(path.dirname(file!))).toBe(false);
    } finally {
      if (file !== undefined) rmSync(file, { force: true });
    }
  });

  it.each(['success', 'failure'])('cleans up a screenshot that finishes with %s after cancellation', async (outcome) => {
    const h = harness();
    let finishCapture: (() => void) | undefined;
    const started = new Promise<string>((captureStarted) => {
      h.fake.respond('capture.screenshot', (args) => new Promise((resolve, reject) => {
        const file = (args as { path: string }).path;
        finishCapture = () => {
          finishCapture = undefined;
          writeFileSync(file, new Uint8Array([1, 2, 3]));
          if (outcome === 'failure') reject(new AppError('COMMAND_FAILED', 'late capture failure'));
          else resolve({ path: file });
        };
        captureStarted(file);
      }));
    });
    await openAttempt(h);
    const controller = new AbortController();
    const pending = h.engine.artifacts!.screenshot('cancelled', operation(controller.signal));
    const file = await started;
    try {
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(finishCapture).toBeTypeOf('function');
      await h.engine.endAttempt!(cleanup());

      let opened = false;
      let temporaryFilesRemoved = false;
      h.fake.respond('apps.open', () => {
        opened = true;
        temporaryFilesRemoved = !existsSync(file) && !existsSync(path.dirname(file));
        return { appName: 'Settings', appBundleId: 'com.apple.Preferences' };
      });
      const next = h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
      await new Promise((resolve) => setImmediate(resolve));
      expect(opened).toBe(false);
      finishCapture!();
      await next;
      expect(opened).toBe(true);
      expect(temporaryFilesRemoved).toBe(true);
      expect(existsSync(path.join(artifactsDir, 'screenshots'))).toBe(false);
    } finally {
      finishCapture?.();
      rmSync(file, { force: true });
    }
  });

  it('waits for an abandoned command to settle before the next attempt opens anything', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    let settled = false;
    h.fake.respond('interactions.press', () => new Promise<void>((resolve) => {
      release = () => {
        settled = true;
        resolve();
      };
    }));
    let openedAfterSettle: boolean | undefined;
    h.fake.respond('apps.open', () => {
      openedAfterSettle = settled;
      return { appName: 'Settings', appBundleId: 'com.apple.Preferences' };
    });
    await openAttempt(h);
    const about = await observed(h, 'About');
    const controller = new AbortController();
    const pending = h.engine.perform!(about.ref, { kind: 'tap' }, operation(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await h.engine.endAttempt!(cleanup());

    const next = h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    let nextDone = false;
    void next.then(() => {
      nextDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nextDone).toBe(false);
    release!();
    await next;
    expect(openedAfterSettle).toBe(true);

    // A command that never settles fails the launch within its budget instead of racing it.
    h.fake.respond('interactions.press', () => new Promise<void>(() => undefined));
    const stuck = await observed(h, 'About');
    const abort = new AbortController();
    const hung = h.engine.perform!(stuck.ref, { kind: 'tap' }, operation(abort.signal));
    abort.abort();
    await expect(hung).rejects.toMatchObject({ code: 'CANCELLED' });
    await h.engine.endAttempt!(cleanup());
    const launch = new AbortController();
    const launching = h.engine.startAttempt!({ attemptId: 'a3', artifactsDir, signal: launch.signal });
    launch.abort();
    await expect(launching).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('device fixture', () => {
  const minted: unknown[] = [];
  function fixture(h: Harness): Device {
    const context = {
      targetName: 'ios-simulator',
      fixture: (_name: string, value: object) => value,
      signal: new AbortController().signal,
      locator: (expression: unknown) => {
        minted.push(expression);
        return { minted: true };
      },
    } as unknown as EngineFixtureContext;
    return h.engine.fixtures!['device']!(context) as Device;
  }

  it('reads the harness signal per call, so teardown after a body timeout still drives the device', async () => {
    const h = harness();
    await openAttempt(h);
    const timedOut = new AbortController();
    timedOut.abort();
    let current = timedOut.signal;
    const context = {
      targetName: 'ios-simulator',
      fixture: (_name: string, value: object) => value,
      get signal() {
        return current;
      },
      locator: () => undefined,
    } as unknown as EngineFixtureContext;
    const device = h.engine.fixtures!['device']!(context) as Device;
    // The body's signal is dead...
    await expect(device.home()).rejects.toMatchObject({ code: 'CANCELLED' });
    // ...and the same fixture instance follows the harness into the afterEach budget.
    current = new AbortController().signal;
    await expect(device.home()).resolves.toBeUndefined();
    expect(h.fake.methods().filter((method) => method === 'command.home')).toHaveLength(1);
  });

  it('mints a core locator from an agent-device selector without a device round trip', async () => {
    const h = harness();
    await openAttempt(h);
    const before = h.fake.calls.length;
    expect(fixture(h).locator('id=About')).toEqual({ minted: true });
    expect(minted).toEqual([{ kind: 'selector', selector: 'id=About' }]);
    expect(h.fake.calls.length).toBe(before);
  });

  it('installs a build from a test, replacing by default and removing first on reinstall', async () => {
    const h = harness();
    await openAttempt(h);
    h.fake.respond('apps.install', () => ({ app: './b/App.app', appPath: '/b/App.app', platform: 'ios', bundleId: 'com.example.app', identifiers: {} }));
    h.fake.respond('apps.reinstall', () => ({ app: 'com.example.app', appPath: '/b/App.app', platform: 'ios', identifiers: {} }));
    const device = fixture(h);
    const before = h.fake.calls.length;
    expect(await device.installApp('./b/App.app')).toEqual({ app: 'com.example.app', bundleId: 'com.example.app' });
    expect(await device.installApp('/b/App.app', { reinstall: true })).toEqual({ app: 'com.example.app' });
    expect(await device.installApp('/b/App.app', { app: 'com.other', reinstall: true })).toEqual({ app: 'com.example.app' });
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['apps.install', { platform: 'ios', appPath: '/project/b/App.app' }],
      ['apps.reinstall', { platform: 'ios', app: 'Settings', appPath: '/b/App.app' }],
      ['apps.reinstall', { platform: 'ios', app: 'com.other', appPath: '/b/App.app' }],
    ]);

    const free = harness({}, false);
    await openAttempt(free);
    await expect(fixture(free).installApp('/b/App.app', { reinstall: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(free.fake.methods()).toEqual(['devices.boot']);
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

describe('reference lifetime and cancellation', () => {
  it('bounds located bindings while preserving current observation ids', async () => {
    const h = harness();
    await openAttempt(h);
    const observation = await observed(h, 'About');
    const expression = { kind: 'selector', selector: 'id=ABOUT' } as const;
    const [oldest] = await h.engine.locate!(expression, operation());
    let newest = oldest!;
    for (let i = 0; i < 2050; i += 1) {
      [newest] = (await h.engine.locate!(expression, operation())) as [SemanticNode];
    }
    await expect(h.engine.perform!(oldest!.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(h.engine.perform!(newest.ref, { kind: 'tap' }, operation())).resolves.toBeUndefined();
    await expect(h.engine.perform!(observation.ref, { kind: 'tap' }, operation())).resolves.toBeUndefined();
  });

  it('captures an observation location in the same snapshot while explicit URL probes stay fresh', async () => {
    const h = harness();
    await openAttempt(h);
    const before = h.fake.methods().filter((method) => method === 'capture.snapshot').length;
    const snapshot = await h.engine.observe!(operation());
    expect(snapshot.url).toBe('app://device/com.apple.preferences/General');
    expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(before + 1);
    h.fake.respond('capture.snapshot', () => ({ ...SETTINGS_SNAPSHOT, appBundleId: 'other.app' }));
    expect(await h.engine.url!(operation())).toBe('app://device/other.app/General');
  });

  it('never dispatches a command or action when its signal is already aborted', async () => {
    const h = harness();
    await openAttempt(h);
    const node = await observed(h, 'About');
    const before = h.fake.calls.length;
    const signal = AbortSignal.abort();
    await expect(h.surface.command('home', (client) => client.command.home({}), signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(h.engine.perform!(node.ref, { kind: 'tap' }, operation(signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(h.fake.calls).toHaveLength(before);
  });
});
