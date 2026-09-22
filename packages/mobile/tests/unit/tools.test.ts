import { describe, expect, it } from 'vitest';
import { defineEngine } from 'e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { mobileTools } from '../../src/tools.ts';
import { createFakeClient } from '../helpers/fake-client.ts';

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
    const android = buildEngine(new AgentDeviceSurface({ platform: 'android' }, () => androidFake.client));
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

    const attempt = (attemptId: string) => ({ attemptId, artifactsDir: '/tmp', signal: new AbortController().signal, registerSecret: () => undefined });
    await android.startAttempt!(attempt('a1'));
    expect(await run('open_app', { app: 'Clock', relaunch: true })).toBe('Opened Clock.');
    expect(await run('swipe', { from: { x: 300, y: 200 }, to: { x: 20, y: 200 } })).toMatch(/Swiped/);
    expect(await run('alert', { action: 'dismiss' })).toBe('Alert dismissed.');
    expect(androidFake.methods().slice(1)).toEqual([
      'apps.open',
      'interactions.swipe',
      'command.alert',
    ]);
    expect(androidFake.lastArgs('apps.open')).toEqual({ app: 'Clock', platform: 'android', relaunch: true });
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
    await ios.startAttempt!({ attemptId: 'a1', artifactsDir: '/tmp', signal: new AbortController().signal, registerSecret: () => undefined });
    const tools = mobileTools(ios);
    const open = (app: string) =>
      (tools.open_app!.tool.execute as (input: unknown, options: object) => Promise<unknown>)({ app }, {
        toolCallId: 'c1',
        messages: [],
      });
    const before = fake.calls.length;
    for (const denied of ['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)']) {
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
});
