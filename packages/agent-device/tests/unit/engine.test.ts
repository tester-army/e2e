/**
 * The agent-device engine through the public contract, with a scripted
 * client: lifecycle order, the command each contract member issues, id
 * staleness, the screen location, artifacts, and the contributed fixture. No
 * simulator: what is asserted is the command stream, which is the whole of
 * what this engine owes agent-device.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from 'agent-device';
import { decodePng, encodePng } from '../helpers/png.ts';
import type { EngineFixtureContext, OperationContext, SemanticNode } from 'e2e/engine';
import type { Device } from '../../src/device.ts';
import { SETTINGS_NODES, SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';
import { boot, harness, poolVariableIn, PROJECT_ROOT, type Harness } from '../helpers/harness.ts';

/** An agent's operation: the agent reads the screen right after acting, so its actions settle. */
function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 30_000, runId: 'run-1', attemptId: 'a1', origin: 'agent' };
}

function cleanup() {
  return { signal: new AbortController().signal, timeoutMs: 5_000 };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  return named(snapshot.root, name);
}

function named(root: SemanticNode, name: string): SemanticNode {
  const found = [...walk(root)].find((node) => node.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

/** Every node under the root, the root excluded: the device's own tree. */
function* walk(root: SemanticNode): Generator<SemanticNode> {
  for (const node of root.children ?? []) {
    yield node;
    yield* walk(node);
  }
}

/** The screen root of an observation, `perform(root, swipe)` being the viewport swipe. */
async function screenRootOf(h: Harness): Promise<SemanticNode> {
  return (await h.engine.observe!(operation())).root;
}

describe('manifest', () => {
  it('declares observation, actions, location, artifacts, the device fixture, and session hooks by option', () => {
    const pinned = harness().engine;
    expect([...pinned.capabilities].toSorted()).toEqual(['actions', 'artifacts', 'device', 'keyboard', 'location', 'observation', 'pointer']);
    expect(pinned.name).toBe('agent-device');
    expect(pinned.version).not.toBe('unknown');
    expect(Object.keys(pinned.app!)).toEqual(['identity']);
    expect(pinned.app!.identity).toBe('Settings');
    expect(Object.keys(pinned.session!).toSorted()).toEqual(['back', 'reset', 'restart']);
    // No `open`: a device app has no URL. No select verb either: the touch surface has no option lists to pick from.
    expect(pinned.session!.open).toBeUndefined();
    expect(pinned.actions).toEqual(['tap', 'doubleTap', 'longPress', 'fill', 'clear', 'press', 'check', 'uncheck', 'focus', 'hover', 'dragTo', 'swipe']);
    expect(pinned.state).toBeUndefined();

    const free = harness({}, false).engine;
    expect(free.app).toEqual({});
    expect(Object.keys(free.session!)).toEqual(['back']);
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
  it('boots once per init under a session named after the target and worker slot, opens the app fresh per attempt, and closes on dispose', async () => {
    const h = harness();
    await openAttempt(h);
    expect(h.sessions).toEqual(['e2e-ios-simulator-0']);
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
    expect(h.sessions).toEqual(['e2e-ios-simulator-0', 'e2e-second-0']);
  });

  it('honours an explicit session and device, and does not open anything without a pinned app', async () => {
    const h = harness({ session: 'qa-run', device: 'iPhone 16e' }, false);
    await openAttempt(h);
    expect(h.sessions).toEqual(['qa-run-0']);
    expect(h.fake.methods()).toEqual(['devices.boot']);
    expect(h.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 16e' });
  });

  it('hands each worker slot its own device from a pool, under a slot-suffixed session', async () => {
    const pool = ['iPhone 17', 'iPhone 17 Pro'] as const;
    const first = harness({ device: pool });
    await boot(first.engine, 'ios', 0);
    expect(first.sessions).toEqual(['e2e-ios-0']);
    expect(first.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 17' });
    await first.engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal });
    expect(first.fake.lastArgs('apps.open')).toEqual({ app: 'Settings', platform: 'ios', device: 'iPhone 17', relaunch: true });

    const second = harness({ device: pool, session: 'qa' });
    await boot(second.engine, 'ios', 1);
    expect(second.sessions).toEqual(['qa-1']);
    expect(second.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 17 Pro' });

    const third = harness({ device: pool });
    await expect(boot(third.engine, 'ios', 2)).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('worker slot 2 is outside a device pool of 2'),
    });
    expect(third.fake.methods()).toEqual([]);
  });

  it('declares one worker per device and prepares each slot the run uses: a boot, then the pinned app opened once to bring the runner up', async () => {
    const pool = ['iPhone 17', 'iPhone 17 Pro', 'iPhone Air'] as const;
    const h = harness({ device: pool });
    expect(h.engine.workers).toBe(3);
    const lines: string[] = [];
    await h.engine.prepare!({
      runId: 'run-1',
      targetName: 'ios',
      projectRoot: PROJECT_ROOT,
      slots: 2,
      env: {},
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
    });
    expect(h.sessions).toEqual(['e2e-ios-0', 'e2e-ios-1']);
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.open', 'devices.boot', 'apps.open']);
    expect(h.fake.calls[0]!.args).toEqual({ platform: 'ios', device: 'iPhone 17' });
    expect(h.fake.calls[1]!.args).toEqual({ app: 'Settings', platform: 'ios', device: 'iPhone 17' });
    expect(h.fake.calls[2]!.args).toEqual({ platform: 'ios', device: 'iPhone 17 Pro' });
    expect(lines).toEqual(['booting iPhone 17 (1 of 2)', 'booting iPhone 17 Pro (2 of 2)']);

    // Without a pinned app there is nothing to open; a build `appPath` installs in init, so it boots only too.
    const bare = harness({ device: 'iPhone 16e' }, false);
    await bare.engine.prepare!({ runId: 'run-1', targetName: 'ios', projectRoot: PROJECT_ROOT, slots: 1, env: {}, signal: new AbortController().signal, log: () => undefined });
    expect(bare.fake.methods()).toEqual(['devices.boot']);
    const build = harness({ device: 'iPhone 16e', appPath: 'build/App.app' });
    await build.engine.prepare!({ runId: 'run-1', targetName: 'ios', projectRoot: PROJECT_ROOT, slots: 1, env: {}, signal: new AbortController().signal, log: () => undefined });
    expect(build.fake.methods()).toEqual(['devices.boot']);

    const single = harness({ device: 'iPhone 16e', session: 'qa' });
    expect(single.engine.workers).toBe(1);
    await single.engine.prepare!({
      runId: 'run-1',
      targetName: 'ios',
      projectRoot: PROJECT_ROOT,
      slots: 1,
      env: {},
      signal: new AbortController().signal,
      log: () => undefined,
    });
    expect(single.sessions).toEqual(['qa-0']);
    expect(single.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 16e' });
  });

  it('logs a runner that does not warm up in prepare instead of failing the run; a device that cannot boot does fail it', async () => {
    const h = harness({ device: 'iPhone 16e' });
    h.fake.respond('apps.open', () => {
      throw new Error('runner still installing');
    });
    const lines: string[] = [];
    const info = { runId: 'run-1', targetName: 'ios', projectRoot: PROJECT_ROOT, slots: 1, env: {}, signal: new AbortController().signal, log: (line: string) => lines.push(line) };
    await h.engine.prepare!(info);
    expect(lines[1]).toMatch(/runner not warmed up.*runner still installing/);

    h.fake.respond('devices.boot', () => {
      throw new Error('no such device');
    });
    await expect(h.engine.prepare!(info)).rejects.toMatchObject({ message: expect.stringContaining('no such device') });
  });

  it('discovers every booted device of the platform when no device is named, boots as many as the run has slots, and reports the pool', async () => {
    const inventory = [
      { platform: 'android', id: 'Pixel_9', name: 'Pixel 9', booted: true },
      { platform: 'ios', id: '2BBF3F07-AF66-4F95-82AB-BF442506FC89', name: 'iPhone 16e', booted: true },
      { platform: 'ios', id: '8A2DC8D6-7B20-44FA-ADBB-47D3EAE6E8F3', name: 'iPhone 17', booted: true },
      { platform: 'ios', id: 'CAB49ABB-4A25-48B3-99C9-949153F95902', name: 'iPhone 17 Pro Max', booted: false },
    ];
    const h = harness({ device: undefined });
    h.fake.respond('devices.list', () => inventory);
    expect(h.engine.workers).toBeUndefined();
    const env: NodeJS.ProcessEnv = {};
    const lines: string[] = [];
    const result = await h.engine.prepare!({
      runId: 'run-1',
      targetName: 'ios',
      projectRoot: PROJECT_ROOT,
      slots: 4,
      env,
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ workers: 2 });
    expect(h.fake.lastArgs('devices.list')).toEqual({ platform: 'ios' });
    // Both booted iPhones, by UDID, under slot sessions; the Android device and the shut-down iPhone are not the pool's.
    expect(h.fake.calls.filter((call) => call.method === 'devices.boot').map((call) => call.args)).toEqual([
      { platform: 'ios', udid: '2BBF3F07-AF66-4F95-82AB-BF442506FC89' },
      { platform: 'ios', udid: '8A2DC8D6-7B20-44FA-ADBB-47D3EAE6E8F3' },
    ]);
    expect(h.sessions).toEqual(['e2e-ios-0', 'e2e-ios-0', 'e2e-ios-1']);
    expect(lines[0]).toMatch(/2 booted ios device\(s\); driving 2/);
    // The workers read the pool from the environment prepare's result adds, never from a second inventory.
    const handed = result?.env ?? {};
    const variable = poolVariableIn(handed, 'IOS');
    expect(handed[variable]).toBe(
      JSON.stringify([{ device: '2BBF3F07-AF66-4F95-82AB-BF442506FC89' }, { device: '8A2DC8D6-7B20-44FA-ADBB-47D3EAE6E8F3' }]),
    );
    expect(env).toEqual({});
    // A worker reads the pool from the environment it was started with, never process.env.
    const worker = harness({ device: undefined });
    await boot(worker.engine, 'ios', 1, { [variable]: handed[variable] });
    expect(worker.fake.methods()).toEqual(['devices.boot']);
    expect(worker.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', udid: '8A2DC8D6-7B20-44FA-ADBB-47D3EAE6E8F3' });
    expect(worker.sessions).toEqual(['e2e-ios-1']);
  });

  it('with fewer slots than booted devices drives only that many; with none booted, one slot boots what agent-device picks', async () => {
    const h = harness({ device: undefined });
    h.fake.respond('devices.list', () => [
      { platform: 'ios', id: 'A', name: 'A', booted: true },
      { platform: 'ios', id: 'B', name: 'B', booted: true },
    ]);
    const env: NodeJS.ProcessEnv = {};
    const info = { runId: 'run-1', targetName: 'ios', projectRoot: PROJECT_ROOT, slots: 1, env, signal: new AbortController().signal, log: () => undefined };
    const first = await h.engine.prepare!(info);
    expect(first?.workers).toBe(1);
    const firstEnv = first?.env ?? {};
    expect(h.fake.calls.filter((call) => call.method === 'devices.boot').map((call) => call.args)).toEqual([{ platform: 'ios', device: 'A' }]);
    expect(firstEnv[poolVariableIn(firstEnv, 'IOS')]).toBe(JSON.stringify([{ device: 'A' }]));
    // The same handle prepared again, for another target, discovers afresh and hands back that target's own variable.
    h.fake.respond('devices.list', () => [{ platform: 'ios', id: 'C', name: 'C', booted: true }]);
    const second = await h.engine.prepare!({ ...info, targetName: 'ios.a', env });
    const secondEnv = second?.env ?? {};
    expect(h.fake.methods().filter((method) => method === 'devices.list')).toHaveLength(2);
    expect(secondEnv[poolVariableIn(secondEnv, 'IOS_A')]).toBe(JSON.stringify([{ device: 'C' }]));
    // Names that sanitize alike keep distinct variables.
    const third = await h.engine.prepare!({ ...info, targetName: 'ios-a', env });
    expect(Object.keys(third?.env ?? {})[0]).not.toBe(Object.keys(secondEnv)[0]);
    expect(Object.keys(third?.env ?? {})[0]).toMatch(/^E2E_AGENT_DEVICE_POOL_IOS_A_/);

    const cold = harness({ device: undefined });
    cold.fake.respond('devices.list', () => []);
    const coldEnv: NodeJS.ProcessEnv = {};
    const coldResult = await cold.engine.prepare!({ ...info, env: coldEnv });
    expect(coldResult).toMatchObject({ workers: 1 });
    expect(cold.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios' });
    const coldHanded = coldResult?.env ?? {};
    // One slot bound to no device in particular: the daemon picks.
    expect(coldHanded[poolVariableIn(coldHanded, 'IOS')]).toBe('[{}]');
    expect(coldEnv).toEqual({});
  });

  it('selects a named device by name and a UDID by udid', async () => {
    const byName = harness({ device: 'iPhone 16e' });
    await boot(byName.engine);
    expect(byName.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', device: 'iPhone 16e' });
    const byId = harness({ device: '2BBF3F07-AF66-4F95-82AB-BF442506FC89' });
    await openAttempt(byId);
    expect(byId.fake.lastArgs('devices.boot')).toEqual({ platform: 'ios', udid: '2BBF3F07-AF66-4F95-82AB-BF442506FC89' });
    expect(byId.fake.lastArgs('apps.open')).toEqual({ app: 'Settings', platform: 'ios', udid: '2BBF3F07-AF66-4F95-82AB-BF442506FC89', relaunch: true });
  });

  it('carries the configured settle window on actions, and none when settle is false', async () => {
    const slow = harness({ settle: 600 });
    await openAttempt(slow);
    const node = await observed(slow, 'About');
    await slow.engine.perform!(node.ref, { kind: 'tap' }, operation());
    expect(slow.fake.lastArgs('interactions.press')).toEqual({ ref: '@e4', settle: true, settleQuietMs: 600 });

    const none = harness({ settle: false });
    await openAttempt(none);
    const target = await observed(none, 'About');
    await none.engine.perform!(target.ref, { kind: 'tap' }, operation());
    expect(none.fake.lastArgs('interactions.press')).toEqual({ ref: '@e4' });
    await none.engine.session!.back!(operation());
    expect(none.fake.lastArgs('command.back')).toEqual({});

    expect(() => harness({ settle: -1 })).toThrow(/non-negative integer/);
    expect(() => harness({ settle: 1.5 })).toThrow(/non-negative integer/);
  });

  it('rejects an empty pool at config time', () => {
    expect(() => harness({ device: [] })).toThrow(/empty pool/);
  });

  it('takes undefined for every optional option, so env-driven configs need no conditional spreads', async () => {
    const h = harness(
      { app: undefined, appPath: undefined, identity: undefined, environment: undefined, device: undefined, session: undefined, snapshot: undefined },
      false,
    );
    expect(Object.keys(h.engine.session!)).toEqual(['back']);
    await openAttempt(h);
    expect(h.sessions).toEqual(['e2e-ios-simulator-0']);
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
    expect(Object.keys(h.engine.session!).toSorted()).toEqual(['back', 'reset', 'restart']);
    await openAttempt(h);
    expect(h.fake.methods()).toEqual(['devices.boot', 'apps.install', 'apps.open']);
    expect(h.fake.lastArgs('apps.install')).toEqual({ platform: 'ios', appPath: '/project/build/App.app' });
    expect(h.fake.lastArgs('apps.open')).toEqual({ app: 'com.example.app', platform: 'ios', relaunch: true });

    await h.engine.endAttempt!(cleanup());
    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    expect(h.fake.methods().filter((m) => m === 'apps.install')).toHaveLength(1);

    await h.engine.session!.reset!(operation());
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
  it('projects the snapshot under one stable screen root with a viewport, and a fresh id generation each time', async () => {
    const h = harness();
    await openAttempt(h);
    const first = await h.engine.observe!(operation());
    expect(first.viewport).toEqual({ width: 390, height: 844 });
    expect(first.location).toBe('com.apple.Preferences / General');
    // The device's application node sits under a root the engine mints: same id every time, the viewport as its box.
    expect(first.root).toMatchObject({ ref: { id: 'root' }, role: 'screen', rect: { x: 0, y: 0, width: 390, height: 844 } });
    expect(first.root.children).toHaveLength(1);
    expect(first.root.children![0]!.role).toBe('application');
    expect(h.fake.lastArgs('capture.snapshot')).toEqual({ interactiveOnly: false });
    const about = named(first.root, 'About');

    const second = await h.engine.observe!(operation());
    expect(second.root.ref.id).toBe(first.root.ref.id);
    const aboutAgain = named(second.root, 'About');
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
    expect([...walk(snapshot.root)]).toHaveLength(10);
  });

  it('is an empty screen before any app is open when no app is pinned, and a fault when one is', async () => {
    const free = harness({}, false);
    free.fake.respond('capture.snapshot', () => {
      throw new AppError('SESSION_NOT_FOUND', 'No active app session');
    });
    // No tree means no geometry: the viewport comes from the device's screenshot metadata, once.
    free.fake.respond('capture.screenshot', () => ({ logicalWidth: 390, logicalHeight: 844, width: 1170, height: 2532, pixelDensity: 3 }));
    await openAttempt(free);
    const empty = await free.engine.observe!(operation());
    expect(empty).toEqual({
      root: { ref: { id: 'root', revision: '' }, role: 'screen', rect: { x: 0, y: 0, width: 390, height: 844 } },
      viewport: { width: 390, height: 844 },
    });
    await free.engine.observe!(operation());
    expect(free.fake.methods().filter((method) => method === 'capture.screenshot')).toHaveLength(1);

    // A device that reports no geometry at all cannot be observed: an invented viewport would misplace every tap.
    const blind = harness({}, false);
    blind.fake.respond('capture.snapshot', () => ({ nodes: [] }));
    blind.fake.respond('capture.screenshot', () => ({}));
    await openAttempt(blind);
    await expect(blind.engine.observe!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('viewport is unknown'),
    });

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
    expect(unmaskable.root.children).toHaveLength(1);
    // A snapshot without geometry keeps the viewport the session last learned.
    expect(unmaskable.viewport).toEqual({ width: 390, height: 844 });

    h.fake.respond('capture.snapshot', () => SETTINGS_SNAPSHOT);
    h.fake.respond('capture.screenshot', () => {
      throw new AppError('COMMAND_FAILED', 'screenshot failed');
    });
    const treeOnly = await h.engine.observe!(operation(), { pixels: true });
    expect(treeOnly.pixels).toBeUndefined();
    expect(treeOnly.root.children).toHaveLength(1);
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
      { ref: '@e3', settle: true, settleQuietMs: 150 },
      { ref: '@e4', settle: true, settleQuietMs: 150 },
    ]);
  });
});

describe('perform', () => {
  it('maps every supported action onto one agent-device command', async () => {
    const h = harness();
    await openAttempt(h);
    const op = operation();
    const { root } = await h.engine.observe!(op);
    const [about, toggle, search, scroller, back] = ['About', 'Airplane Mode', 'Search', 'Scroller', 'Back'].map((name) =>
      named(root, name),
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
    await h.engine.perform!(search!.ref, { kind: 'press', key: 'Space' }, op);
    await h.engine.perform!(scroller!.ref, { kind: 'swipe', direction: 'down' }, op);
    await h.engine.perform!(root.ref, { kind: 'swipe', direction: 'up', momentum: 'fast' }, op);
    await h.engine.perform!(about!.ref, { kind: 'dragTo', target: back!.ref }, op);
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['interactions.press', { ref: '@e4', settle: true, settleQuietMs: 150 }],
      ['interactions.press', { ref: '@e4', doubleTap: true, settle: true, settleQuietMs: 150 }],
      ['interactions.longPress', { ref: '@e4', settle: true, settleQuietMs: 150, durationMs: 900 }],
      ['interactions.press', { ref: '@e7', settle: true, settleQuietMs: 150 }],
      ['interactions.hover', { ref: '@e4' }],
      ['interactions.fill', { ref: '@e7', text: 'blue', settle: true, settleQuietMs: 150 }],
      ['interactions.fill', { ref: '@e7', text: '', settle: true, settleQuietMs: 150 }],
      ['interactions.press', { ref: '@e6', settle: true, settleQuietMs: 150 }],
      ['command.keyboard', { action: 'enter' }],
      ['interactions.press', { ref: '@e7', settle: true, settleQuietMs: 150 }],
      ['interactions.type', { text: 'a' }],
      // Space is typed like a character, the unfocused field tapped first.
      ['interactions.press', { ref: '@e7', settle: true, settleQuietMs: 150 }],
      ['interactions.type', { text: ' ' }],
      ['interactions.swipe', { from: { x: 195, y: 620 }, to: { x: 195, y: 420 } }],
      // The root swipe is the viewport swipe: agent-device's whole-screen scroll.
      ['interactions.scroll', { direction: 'up' }],
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
    const { root } = await h.engine.observe!(operation());
    const haptic = named(root, 'Haptic Feedback');
    const sound = named(root, 'Sound');
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
      { ref: '@e4', settle: true, settleQuietMs: 150 },
      { ref: '@e4', settle: true, settleQuietMs: 150 },
      { ref: '@e5', settle: true, settleQuietMs: 150 },
      { ref: '@e4', settle: true, settleQuietMs: 150 },
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
      // Named keys other than Enter and Space, and every modifier, have no soft-keyboard equivalent.
      { kind: 'press', key: 'Escape' },
      { kind: 'press', key: 'Tab' },
      { kind: 'press', key: 'Control+a' },
      { kind: 'press', key: 'Shift+Enter' },
      // A tap would activate the row; focus is for editable fields only.
      { kind: 'focus' },
      // The row-level cell exposes no checked state; a blind flip could undo a correct one.
      { kind: 'check' },
    ] as const) {
      await expect(h.engine.perform!(about.ref, action, operation())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
      });
    }
    // A spelling outside the grammar is refused with the grammar named, never reinterpreted.
    for (const key of ['Return', 'ab', '', 'Enter+']) {
      await expect(h.engine.perform!(about.ref, { kind: 'press', key }, operation())).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('[Modifier+]...Key'),
      });
    }
    // The root takes swipe only.
    await expect(h.engine.perform!({ id: 'root', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({
      code: 'NOT_ACTIONABLE',
    });
    expect(h.fake.methods().filter((method) => method === 'interactions.press')).toHaveLength(0);
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

describe('session hooks, viewport swipe, location, artifacts', () => {
  it('scrolls the viewport through the root, goes back, relaunches, and resets state through the pinned app', async () => {
    const h = harness();
    await openAttempt(h);
    const root = await screenRootOf(h);
    const before = h.fake.calls.length;
    await h.engine.perform!(root.ref, { kind: 'swipe', direction: 'down', momentum: 'fast' }, operation());
    await h.engine.session!.back!(operation());
    await h.engine.session!.restart!(operation());
    await h.engine.session!.reset!(operation());
    expect(h.fake.calls.slice(before).map((call) => [call.method, call.args])).toEqual([
      ['interactions.scroll', { direction: 'down' }],
      ['command.back', { settle: true, settleQuietMs: 150 }],
      ['apps.open', { app: 'Settings', platform: 'ios', relaunch: true }],
      ['settings.update', { setting: 'clear-app-state', state: 'clear', app: 'Settings' }],
      ['apps.open', { app: 'Settings', platform: 'ios', relaunch: true }],
    ]);
  });

  it('locates the observation on the foreground app and the screen title, and omits what it does not know', async () => {
    const h = harness();
    await openAttempt(h);
    const location = async (harnessed: Harness) => (await harnessed.engine.observe!(operation())).location;
    expect(await location(h)).toBe('com.apple.Preferences / General');
    // No title bar: the app alone. The app identity is remembered from the launch when the snapshot omits it.
    h.fake.respond('capture.snapshot', () => ({ nodes: [{ ref: '@e1', type: 'button', label: 'Go' }] }));
    expect(await location(h)).toBe('com.apple.Preferences');
    h.fake.respond('capture.snapshot', () => ({ ...SETTINGS_SNAPSHOT, appBundleId: 'other.app' }));
    expect(await location(h)).toBe('other.app / General');
    // Nothing pinned, nothing opened, no title: no location, and never an invented URL.
    const cold = harness({}, false);
    await openAttempt(cold);
    cold.fake.respond('capture.snapshot', () => ({ nodes: [{ ref: '@e1', type: 'button', rect: { x: 0, y: 0, width: 10, height: 10 } }] }));
    expect(await location(cold)).toBeUndefined();
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
      ['command.back', { settle: true, settleQuietMs: 150 }],
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

  it('reads the observation location off the same snapshot as the tree', async () => {
    const h = harness();
    await openAttempt(h);
    const before = h.fake.methods().filter((method) => method === 'capture.snapshot').length;
    const snapshot = await h.engine.observe!(operation());
    expect(snapshot.location).toBe('com.apple.Preferences / General');
    expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(before + 1);
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

describe('video', () => {
  const recorder = (h: Harness, finalizeAt?: string) => {
    let requested: string | undefined;
    h.fake.respond('recording.record', (args) => {
      const options = args as { action: 'start' | 'stop'; path?: string };
      if (options.action === 'start') {
        requested = options.path;
        return { recording: 'started', outPath: finalizeAt ?? options.path, sessionStateDir: '/tmp', showTouches: true };
      }
      const written = finalizeAt ?? requested!;
      writeFileSync(written, 'mp4 bytes');
      return { recording: 'stopped', outPath: written, artifacts: [], durationMs: 1200, showTouches: true };
    });
  };
  const records = (h: Harness) => h.fake.methods().filter((method) => method === 'recording.record');

  it('starts and stops the device recorder into the attempt directory and reports one segment', async () => {
    const h = harness();
    recorder(h);
    await openAttempt(h);
    // Nothing recording yet: nothing to stop, and no device command spent on it.
    expect(await h.engine.artifacts!.stopVideo!(operation())).toEqual([]);
    expect(records(h)).toHaveLength(0);
    await h.engine.artifacts!.startVideo!(operation());
    expect(h.fake.lastArgs('recording.record')).toEqual({
      action: 'start',
      path: path.join(artifactsDir, 'video', 'video.mp4'),
      quality: 'medium',
    });
    const segments = await h.engine.artifacts!.stopVideo!(operation());
    expect(h.fake.lastArgs('recording.record')).toEqual({ action: 'stop' });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.path).toBe(path.join('video', 'video.mp4'));
    expect(Number.isNaN(Date.parse(segments[0]!.startedAt))).toBe(false);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.mp4'))).toBe(true);
    await h.engine.endAttempt!(cleanup());
    expect(records(h)).toHaveLength(2);
  });

  it('moves a recording the device finalized elsewhere into place, and stops a dangling one at attempt end', async () => {
    const h = harness();
    const elsewhere = path.join(artifactsDir, 'elsewhere.mp4');
    recorder(h, elsewhere);
    await openAttempt(h);
    await h.engine.artifacts!.startVideo!(operation());
    const segments = await h.engine.artifacts!.stopVideo!(operation());
    expect(segments.map((segment) => segment.path)).toEqual([path.join('video', 'video.mp4')]);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.mp4'))).toBe(true);
    expect(existsSync(elsewhere)).toBe(false);
    await h.engine.endAttempt!(cleanup());
    // A recording still running when the attempt ends is stopped, best-effort.
    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    await h.engine.artifacts!.startVideo!(operation());
    const before = records(h).length;
    await h.engine.endAttempt!(cleanup());
    expect(records(h)).toHaveLength(before + 1);
    expect(h.fake.lastArgs('recording.record')).toEqual({ action: 'stop' });
  });

  it('stops a start that outlived its budget, and keeps a recording whose stop failed for endAttempt', async () => {
    const h = harness();
    let releaseStart: (() => void) | undefined;
    let stops = 0;
    let failNextStop = false;
    h.fake.respond('recording.record', (args) => {
      const options = args as { action: 'start' | 'stop'; path?: string };
      if (options.action === 'start') {
        return new Promise((resolve) => {
          releaseStart = () =>
            resolve({ recording: 'started', outPath: options.path, sessionStateDir: '/tmp', showTouches: true });
        });
      }
      stops += 1;
      if (failNextStop) {
        failNextStop = false;
        throw new Error('recorder busy');
      }
      return { recording: 'stopped', artifacts: [], durationMs: 0, showTouches: true };
    });
    await openAttempt(h);
    // The launch budget expires while the device is still starting the recorder;
    // the recorder comes up anyway, and ending the attempt must stop it.
    const budget = new AbortController();
    const starting = h.engine.artifacts!.startVideo!(operation(budget.signal));
    budget.abort();
    await expect(starting).rejects.toThrow();
    releaseStart!();
    await h.engine.endAttempt!(cleanup());
    expect(stops).toBe(1);

    // A stop that fails keeps the recording marked, so ending the attempt stops it again.
    await h.engine.startAttempt!({ attemptId: 'a2', artifactsDir, signal: new AbortController().signal });
    const started = h.engine.artifacts!.startVideo!(operation());
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStart!();
    await started;
    failNextStop = true;
    await expect(h.engine.artifacts!.stopVideo!(operation())).rejects.toThrow();
    expect(stops).toBe(2);
    await h.engine.endAttempt!(cleanup());
    expect(stops).toBe(3);
    expect(h.fake.lastArgs('recording.record')).toEqual({ action: 'stop' });
  });
});

describe('deterministic actions', () => {
  const test = (): OperationContext => ({ ...operation(), origin: 'test' });

  it('acts at once and without settling on a control that was already on screen before the last action', async () => {
    const h = harness();
    await openAttempt(h);
    // Two looks at the screen: the second is the one the action resolves from, the first stands for the screen before the launch.
    await observed(h, 'About');
    await h.engine.perform!((await observed(h, 'Back')).ref, { kind: 'tap' }, test());
    const startedAt = Date.now();
    const about = await observed(h, 'About');
    await h.engine.perform!(about.ref, { kind: 'tap' }, test());
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(h.fake.lastArgs('interactions.press')).toEqual({ ref: '@e4' });
    expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(3);
  });

  it('gives a control that came with the last action the transition budget before acting on it', async () => {
    const h = harness({ transition: 120 });
    await openAttempt(h);
    await h.engine.perform!((await observed(h, 'Back')).ref, { kind: 'tap' }, test());
    // The next look shows a control that was not there before the tap: a sheet's button.
    h.fake.respond('capture.snapshot', () => ({
      ...SETTINGS_SNAPSHOT,
      nodes: [
        ...SETTINGS_NODES,
        { ref: '@e11', index: 10, parentIndex: 0, depth: 1, type: 'button', label: 'Submit', rect: { x: 0, y: 600, width: 390, height: 44 } },
      ],
    }));
    const startedAt = Date.now();
    const submit = await observed(h, 'Submit');
    await h.engine.perform!(submit.ref, { kind: 'tap' }, test());
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(h.fake.lastArgs('interactions.press')).toEqual({ ref: '@e11' });
  });

  it('gives a control that moved with the last action the budget too, and skips it once the budget has elapsed', async () => {
    const h = harness({ transition: 120 });
    await openAttempt(h);
    await h.engine.perform!((await observed(h, 'Back')).ref, { kind: 'tap' }, test());
    h.fake.respond('capture.snapshot', () => ({
      ...SETTINGS_SNAPSHOT,
      nodes: SETTINGS_NODES.map((node) =>
        node.identifier === 'ABOUT' || node.label === 'About' ? { ...node, rect: { x: 0, y: 300, width: 390, height: 44 } } : node,
      ),
    }));
    let startedAt = Date.now();
    await h.engine.perform!((await observed(h, 'About')).ref, { kind: 'tap' }, test());
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    // Well after the last action, nothing waits.
    await sleep(150);
    startedAt = Date.now();
    await h.engine.perform!((await observed(h, 'About')).ref, { kind: 'tap' }, test());
    expect(Date.now() - startedAt).toBeLessThan(80);
  });

  it('fills, goes back, and taps at a point without settling; the agent keeps the settle path', async () => {
    const h = harness();
    await openAttempt(h);
    await sleep(0);
    const search = await observed(h, 'Search');
    await h.engine.perform!(search.ref, { kind: 'fill', value: 'blue', sensitive: false }, test());
    expect(h.fake.lastArgs('interactions.fill')).toEqual({ ref: '@e7', text: 'blue' });
    await h.engine.session!.back!(test());
    expect(h.fake.lastArgs('command.back')).toEqual({});
    await h.engine.performAt!({ x: 10, y: 20 }, { kind: 'tap' }, test());
    expect(h.fake.lastArgs('interactions.press')).toEqual({ x: 10, y: 20 });
    await h.engine.performAt!({ x: 10, y: 20 }, { kind: 'doubleTap' }, test());
    expect(h.fake.lastArgs('interactions.press')).toEqual({ x: 10, y: 20, doubleTap: true });
    await h.engine.performAt!({ x: 10, y: 20 }, { kind: 'longPress', durationMs: 700 }, test());
    expect(h.fake.lastArgs('interactions.longPress')).toEqual({ x: 10, y: 20, durationMs: 700 });
    await h.engine.performAt!({ x: 10, y: 20 }, { kind: 'swipeTo', target: { x: 10, y: 300 } }, test());
    expect(h.fake.lastArgs('interactions.swipe')).toEqual({ from: { x: 10, y: 20 }, to: { x: 10, y: 300 } });
    expect(h.engine.pointerActions).toEqual(['tap', 'doubleTap', 'longPress', 'swipeTo']);

    const about = await observed(h, 'About');
    await h.engine.perform!(about.ref, { kind: 'tap' }, { ...operation(), origin: 'agent' });
    expect(h.fake.lastArgs('interactions.press')).toEqual({ ref: '@e4', settle: true, settleQuietMs: 150 });
  });

  it('does not dispatch an action whose transition wait was cancelled', async () => {
    const h = harness({ transition: 300 });
    await openAttempt(h);
    const about = await observed(h, 'About');
    const controller = new AbortController();
    const pending = h.engine.perform!(about.ref, { kind: 'tap' }, { ...operation(controller.signal), origin: 'test' });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(h.fake.methods().filter((method) => method === 'interactions.press')).toHaveLength(0);
  });

  it('treats every control as arriving after a launch, even one the previous screen also had', async () => {
    const h = harness({ transition: 120 });
    await openAttempt(h);
    await sleep(150);
    await observed(h, 'About');
    // A relaunch: the same About cell at the same place is on the new screen too.
    await h.engine.session!.restart!(test());
    const startedAt = Date.now();
    await h.engine.perform!((await observed(h, 'About')).ref, { kind: 'tap' }, test());
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  it('does not count a toggle already in the wanted state as an action', async () => {
    const h = harness({ transition: 120 });
    await openAttempt(h);
    await sleep(150);
    // Airplane Mode reads unchecked, so uncheck sends nothing.
    await h.engine.perform!((await observed(h, 'Airplane Mode')).ref, { kind: 'uncheck' }, test());
    expect(h.fake.methods().filter((method) => method === 'interactions.press')).toHaveLength(0);
    h.fake.respond('capture.snapshot', () => ({
      ...SETTINGS_SNAPSHOT,
      nodes: [
        ...SETTINGS_NODES,
        { ref: '@e11', index: 10, parentIndex: 0, depth: 1, type: 'button', label: 'Save', rect: { x: 0, y: 600, width: 390, height: 44 } },
      ],
    }));
    const startedAt = Date.now();
    await h.engine.perform!((await observed(h, 'Save')).ref, { kind: 'tap' }, test());
    expect(Date.now() - startedAt).toBeLessThan(80);
  });

  it('rejects a negative or fractional transition budget', () => {
    expect(() => harness({ transition: -5 })).toThrow(/non-negative integer/);
    expect(() => harness({ transition: 0.5 })).toThrow(/non-negative integer/);
  });
});

