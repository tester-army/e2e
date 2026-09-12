import { describe, expect, it } from 'vitest';
import { defineEngine } from '@e2edev/e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { agentDeviceTools } from '../../src/tools.ts';
import { createFakeClient } from '../helpers/fake-client.ts';

describe('agent tool pack', () => {
  it('scopes every tool to the platforms of its engines and rejects a foreign handle', () => {
    const fake = createFakeClient();
    const ios = buildEngine(new AgentDeviceSurface({ platform: 'ios' }, () => fake.client));
    const android = buildEngine(new AgentDeviceSurface({ platform: 'android' }, () => fake.client));
    const tools = agentDeviceTools(ios);
    expect(Object.keys(tools).toSorted()).toEqual(['alert', 'open_app', 'swipe', 'type_text']);
    for (const defined of Object.values(tools)) {
      expect(defined.annotations.platforms).toEqual(['ios']);
    }
    for (const defined of Object.values(agentDeviceTools(ios, android))) {
      expect(defined.annotations.platforms).toEqual(['ios', 'android']);
    }
    const foreign = defineEngine({ name: 'other', version: '1', spiVersion: 1 });
    expect(() => agentDeviceTools(foreign)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
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
        signal: new AbortController().signal,
      });
    await init(ios, 'ios');
    await init(android, 'android');
    const tools = agentDeviceTools(ios, android);
    const run = async (name: string, input: unknown) =>
      (tools[name]!.tool.execute as (input: unknown, options: object) => Promise<unknown>)(input, {
        toolCallId: 'c1',
        messages: [],
      });

    await expect(run('alert', { action: 'dismiss' })).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const attempt = (attemptId: string) => ({ attemptId, artifactsDir: '/tmp', signal: new AbortController().signal });
    await android.startAttempt!(attempt('a1'));
    expect(await run('open_app', { app: 'Clock', relaunch: true })).toBe('Opened Clock.');
    expect(await run('swipe', { from: { x: 300, y: 200 }, to: { x: 20, y: 200 } })).toMatch(/Swiped/);
    expect(await run('alert', { action: 'dismiss' })).toBe('Alert dismissed.');
    expect(await run('type_text', { text: 'Milk', submit: true })).toBe('Typed "Milk" and pressed Return.');
    expect(androidFake.methods().slice(1)).toEqual([
      'apps.open',
      'interactions.swipe',
      'command.alert',
      'interactions.type',
      'command.keyboard',
    ]);
    expect(androidFake.lastArgs('apps.open')).toEqual({ app: 'Clock', platform: 'android', relaunch: true });
    expect(iosFake.methods()).toEqual(['devices.boot']);
    await android.endAttempt!({ signal: new AbortController().signal, timeoutMs: 1000 });

    await ios.startAttempt!(attempt('a2'));
    expect(await run('open_app', { app: 'Reminders' })).toBe('Opened Reminders.');
    expect(iosFake.lastArgs('apps.open')).toEqual({ app: 'Reminders', platform: 'ios' });
  });
});
