import { describe, expect, it } from 'vitest';
import { defineBackend } from 'e2e/backend';
import { buildBackend } from '../../src/backend.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { agentDeviceTools } from '../../src/tools.ts';
import { createFakeClient } from '../helpers/fake-client.ts';

describe('agent tool pack', () => {
  it('scopes every tool to mobile platforms and rejects a foreign handle', () => {
    const fake = createFakeClient();
    const backend = buildBackend(new AgentDeviceSurface({ platform: 'ios' }, () => fake.client));
    const tools = agentDeviceTools(backend);
    expect(Object.keys(tools).toSorted()).toEqual(['alert', 'open_app', 'screenshot', 'swipe', 'type_text']);
    for (const defined of Object.values(tools)) {
      expect(defined.annotations.platforms).toEqual(['ios', 'android']);
    }
    expect(tools['screenshot']?.annotations.mutates).toBe(false);
    const foreign = defineBackend({ name: 'other', version: '1', spiVersion: 1 });
    expect(() => agentDeviceTools(foreign)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('drives the surface through the shared client', async () => {
    const fake = createFakeClient({ 'apps.open': () => ({ appName: 'Reminders' }) });
    const surface = new AgentDeviceSurface({ platform: 'ios' }, () => fake.client);
    const backend = buildBackend(surface);
    await backend.init!({
      runId: 'r',
      targetName: 't',
      app: { allowedOrigins: [] },
      testIdAttribute: 'data-testid',
      headed: false,
      signal: new AbortController().signal,
    });
    const tools = agentDeviceTools(backend);
    const run = async (name: string, input: unknown) =>
      (tools[name]!.tool.execute as (input: unknown, options: object) => Promise<unknown>)(input, {
        toolCallId: 'c1',
        messages: [],
      });
    expect(await run('open_app', { app: 'Reminders', relaunch: true })).toBe('Opened Reminders.');
    expect(await run('swipe', { from: { x: 300, y: 200 }, to: { x: 20, y: 200 } })).toMatch(/Swiped/);
    expect(await run('alert', { action: 'dismiss' })).toBe('Alert dismissed.');
    expect(await run('type_text', { text: 'Milk', submit: true })).toBe('Typed "Milk" and pressed Return.');
    expect(fake.methods().slice(1)).toEqual([
      'apps.open',
      'interactions.swipe',
      'command.alert',
      'interactions.type',
      'command.keyboard',
    ]);
    expect(fake.lastArgs('apps.open')).toEqual({ app: 'Reminders', platform: 'ios', relaunch: true });
  });
});
