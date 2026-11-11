import { AppError } from 'agent-device';
import { describe, expect, it } from 'vitest';
import { defineEngine } from 'e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { mobileTools } from '../../src/tools.ts';
import { createFakeClient, type FakeClient } from '../helpers/fake-client.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

describe('agent tool pack', () => {
  it('scopes every tool to the platforms of its engines and rejects a foreign handle', () => {
    const fake = createFakeClient();
    const ios = buildEngine(new AgentDeviceSurface({ platform: 'ios' }, () => fake.client));
    const android = buildEngine(new AgentDeviceSurface({ platform: 'android' }, () => fake.client));
    const tools = mobileTools(ios);
    expect(Object.keys(tools).toSorted()).toEqual(['alert', 'open_app', 'swipe']);
    for (const defined of Object.values(tools)) {
      expect(defined.annotations.platforms).toEqual(['ios']);
    }
    for (const defined of Object.values(mobileTools(ios, android))) {
      expect(defined.annotations.platforms).toEqual(['ios', 'android']);
    }
    const foreign = defineEngine({ name: 'other', version: '1', spiVersion: 1 });
    expect(() => mobileTools(foreign)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('dispatches to the engine whose attempt is running, and refuses outside an attempt', async () => {
    const iosFake = createFakeClient({ 'apps.open': () => ({ appName: 'Reminders' }) });
    const androidFake = createFakeClient({ 'apps.open': () => ({ appName: 'Clock' }) });
    const ios = buildEngine(new AgentDeviceSurface({ platform: 'ios' }, () => iosFake.client));
    const android = buildEngine(new AgentDeviceSurface({ platform: 'android', device: 'emulator-5554' }, () => androidFake.client));
    const init = (engine: typeof ios, targetName: string) =>
      engine.init!({
        runId: 'r',
        targetName,
        projectRoot: '/project',
        app: {},
        headed: false,
        workerSlot: 0,
        log: () => undefined,
        env: {},
        signal: new AbortController().signal,
      });
    await init(ios, 'ios');
    await init(android, 'android');
    const tools = mobileTools(ios, android);
    const run = async (name: string, input: unknown) =>
      (tools[name]!.tool.execute as (input: unknown, options: object) => Promise<unknown>)(input, {
        toolCallId: 'c1',
        messages: [],
      });

    await expect(run('alert', { action: 'dismiss' })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const attempt = (attemptId: string) => ({ attemptId, artifactsDir: '/tmp', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await android.startAttempt!(attempt('a1'));
    expect(await run('open_app', { app: 'Clock', relaunch: true })).toBe('Opened Clock.');
    expect(await run('swipe', { from: { x: 300, y: 200 }, to: { x: 20, y: 200 } })).toMatch(/Swiped/);
    expect(await run('alert', { action: 'dismiss' })).toBe('Alert dismissed.');
    expect(androidFake.methods().slice(1)).toEqual([
      'apps.open',
      'interactions.swipe',
      'command.alert',
    ]);
    expect(androidFake.lastArgs('apps.open')).toEqual({ app: 'Clock', platform: 'android', serial: 'emulator-5554', relaunch: true });
    // The alert carries the worker's device, as it can run with no app open.
    expect(androidFake.lastArgs('command.alert')).toEqual({ platform: 'android', serial: 'emulator-5554', action: 'dismiss' });
    expect(iosFake.methods()).toEqual(['devices.boot']);
    await android.endAttempt!({ signal: new AbortController().signal, timeoutMs: 1000 });

    await ios.startAttempt!(attempt('a2'));
    expect(await run('open_app', { app: 'Reminders' })).toBe('Opened Reminders.');
    expect(iosFake.lastArgs('apps.open')).toEqual({ app: 'Reminders', platform: 'ios' });
  });

  it('refuses a link the model hands to open_app before the device sees it', async () => {
    const fake = createFakeClient({ 'apps.open': () => ({ appName: 'Settings' }) });
    const ios = buildEngine(new AgentDeviceSurface({ platform: 'ios' }, () => fake.client));
    await ios.init!({
      runId: 'r',
      targetName: 'ios',
      projectRoot: '/project',
      app: {},
      headed: false,
      workerSlot: 0,
      log: () => undefined,
      env: {},
      signal: new AbortController().signal,
    });
    await ios.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const tools = mobileTools(ios);
    const open = (app: string) =>
      (tools.open_app!.tool.execute as (input: unknown, options: object) => Promise<unknown>)({ app }, {
        toolCallId: 'c1',
        messages: [],
      });
    const before = fake.calls.length;
    for (const denied of ['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'view-source:file:///etc/passwd']) {
      await expect(open(denied)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    for (const link of ['https://example.com/verify', 'myapp://orders/42']) {
      await expect(open(link)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('device.openLink'),
      });
    }
    expect(fake.calls.length).toBe(before);
    expect(tools.open_app!.tool.description).toContain('not a URL');
    expect(await open('com.apple.Preferences')).toBe('Opened com.apple.Preferences.');
    expect(fake.lastArgs('apps.open')).toEqual({ app: 'com.apple.Preferences', platform: 'ios' });
  });

  /** An iOS tool pack inside a running attempt on a target whose `app` is `app`. */
  async function attemptTools(fake: FakeClient, app: { bundleId?: string }) {
    const ios = buildEngine(new AgentDeviceSurface({ platform: 'ios' }, () => fake.client));
    await ios.init!({
      runId: 'r',
      targetName: 'ios',
      projectRoot: '/project',
      app,
      headed: false,
      workerSlot: 0,
      log: () => undefined,
      env: {},
      signal: new AbortController().signal,
    });
    await ios.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const tools = mobileTools(ios);
    return (input: unknown) =>
      (tools.open_app!.tool.execute as (input: unknown, options: object) => Promise<unknown>)(input, {
        toolCallId: 'c1',
        messages: [],
      });
  }

  it('returns to the app under test when open_app names no app', async () => {
    const fake = createFakeClient({ 'apps.open': () => ({ appBundleId: 'dev.e2e.benchmark' }) });
    const open = await attemptTools(fake, { bundleId: 'dev.e2e.benchmark' });
    expect(await open({})).toBe('Opened the app under test (dev.e2e.benchmark).');
    expect(fake.lastArgs('apps.open')).toEqual({ app: 'dev.e2e.benchmark', platform: 'ios' });
    expect(await open({ relaunch: true })).toBe('Opened the app under test (dev.e2e.benchmark).');
    expect(fake.lastArgs('apps.open')).toEqual({ app: 'dev.e2e.benchmark', platform: 'ios', relaunch: true });
  });

  it('asks for an app when the target pins none', async () => {
    const fake = createFakeClient();
    const open = await attemptTools(fake, {});
    const before = fake.calls.length;
    await expect(open({})).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('needs the app') });
    expect(fake.calls.length).toBe(before);
  });

  it('points a name no installed app matches at the app under test, without CLI advice', async () => {
    const fake = createFakeClient({
      'apps.open': () => {
        throw new AppError('APP_NOT_INSTALLED', 'No app found matching "e2eBenchmark"', {
          hint: 'Run apps to discover the exact installed package or bundle id, or install the app before open.',
        });
      },
    });
    const open = await attemptTools(fake, { bundleId: 'dev.e2e.benchmark' });
    const failure = await open({ app: 'e2eBenchmark' }).then(
      () => undefined,
      (error: unknown) => error as Error & { code: string },
    );
    expect(failure?.code).toBe('INVALID_ARGUMENT');
    expect(failure?.message).toContain('Omit app to return to the app under test');
    expect(failure?.message).not.toContain('Run apps');
  });

  it('keeps the device error when the app under test is not installed', async () => {
    const fake = createFakeClient({
      'apps.open': () => {
        throw new AppError('APP_NOT_INSTALLED', 'No app found matching "dev.e2e.benchmark"');
      },
    });
    const open = await attemptTools(fake, { bundleId: 'dev.e2e.benchmark' });
    const failure = await open({}).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain('No app found matching "dev.e2e.benchmark"');
    expect(failure?.message).not.toContain('Omit app');
  });
});
