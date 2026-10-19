import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { boot, harness, type Harness } from '../helpers/harness.ts';

const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 5000, runId: 'r', attemptId: 'a', origin: 'test' };
afterEach(() => { vi.useRealTimers(); });

async function seedPress(h: Harness): Promise<void> {
  h.fake.respond('capture.snapshot', () => ({ nodes: [
    { ref: '@e1', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    { ref: '@e2', index: 1, parentIndex: 0, type: 'Button', label: 'Seed', identifier: 'seed', rect: { x: 20, y: 100, width: 120, height: 40 }, hittable: true },
  ] }));
  const snapshot = await h.engine.observe!(operation);
  const seed = snapshot.root.children?.flatMap((node) => node.children ?? [node]).find((node) => node.name === 'Seed')!;
  const pending = h.engine.perform!(seed.ref, { kind: 'tap' }, operation);
  await setImmediate();
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
  h.fake.calls.length = 0;
}

it('requires advertised bounded press readiness before delegating test taps', async () => {
  const h = harness({ platform: 'android', targetReadiness: 'device' });
  h.fake.respond('devices.capabilities', () => ({ availableCommands: ['press'] }));
  await expect(boot(h, 'android')).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('bounded press geometry') });
  expect(h.fake.methods()).not.toContain('interactions.press');
});

it('delegates a newly arrived test tap without the adapter transition timer or another capture', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const h = harness({ platform: 'android', targetReadiness: 'device', transition: 1500 });
  h.fake.respond('devices.capabilities', () => ({ targetReadiness: { press: 'bounded-geometry' } }));
  await boot(h, 'android');
  await h.engine.session!.restart!(operation);
  await seedPress(h);
  h.fake.respond('capture.snapshot', () => ({ nodes: [
    { ref: '@e1', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    { ref: '@e2', index: 1, parentIndex: 0, type: 'Button', label: 'Submit', identifier: 'submit', rect: { x: 20, y: 100, width: 120, height: 40 }, hittable: true },
  ] }));
  const snapshot = await h.engine.observe!(operation);
  const button = snapshot.root.children?.flatMap((node) => node.children ?? [node]).find((node) => node.name === 'Submit');
  expect(button).toBeDefined();
  const before = h.fake.methods().filter((method) => method === 'capture.snapshot').length;
  const pending = h.engine.perform!(button!.ref, { kind: 'tap' }, operation);
  await setImmediate();
  expect(h.fake.lastArgs('interactions.press')).toEqual({ ref: '@e2' });
  expect(h.fake.methods().filter((method) => method === 'capture.snapshot')).toHaveLength(before);
  expect(vi.getTimerCount()).toBe(0);
  await pending;
});

it('retains the adapter transition wait for a target without a test ID', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const h = harness({ platform: 'android', targetReadiness: 'device', transition: 1500 });
  h.fake.respond('devices.capabilities', () => ({ targetReadiness: { press: 'bounded-geometry' } }));
  await boot(h, 'android');
  await h.engine.session!.restart!(operation);
  await seedPress(h);
  h.fake.respond('capture.snapshot', () => ({ nodes: [
    { ref: '@e1', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    { ref: '@e2', index: 1, parentIndex: 0, type: 'Button', label: 'Submit', rect: { x: 20, y: 100, width: 120, height: 40 }, hittable: true },
  ] }));
  const snapshot = await h.engine.observe!(operation);
  const button = snapshot.root.children?.flatMap((node) => node.children ?? [node]).find((node) => node.name === 'Submit');
  expect(button).toBeDefined();
  const pending = h.engine.perform!(button!.ref, { kind: 'tap' }, operation);
  await setImmediate();
  expect(h.fake.methods()).not.toContain('interactions.press');
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
});

it('retains adapter readiness when an identified row dispatches an anonymous inner control', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const h = harness({ platform: 'android', targetReadiness: 'device', transition: 1500 });
  h.fake.respond('devices.capabilities', () => ({ targetReadiness: { press: 'bounded-geometry' } }));
  await boot(h, 'android');
  await h.engine.session!.restart!(operation);
  await seedPress(h);
  h.fake.respond('capture.snapshot', () => ({ nodes: [
    { ref: '@e1', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    { ref: '@e2', index: 1, parentIndex: 0, type: 'android.widget.CheckBox', label: 'Submit', identifier: 'submit', checked: false, rect: { x: 20, y: 100, width: 120, height: 40 }, hittable: true },
    { ref: '@e3', index: 2, parentIndex: 1, type: 'android.widget.CheckBox', checked: false, rect: { x: 100, y: 100, width: 40, height: 40 }, hittable: true },
  ] }));
  const snapshot = await h.engine.observe!(operation);
  const button = snapshot.root.children?.flatMap((node) => node.children ?? [node]).find((node) => node.name === 'Submit');
  expect(button).toBeDefined();
  const pending = h.engine.perform!(button!.ref, { kind: 'tap' }, operation);
  await setImmediate();
  expect(h.fake.methods()).not.toContain('interactions.press');
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
});

it('keeps the default path free of capability negotiation', async () => {
  const h = harness({ platform: 'android' });
  await boot(h, 'android');
  expect(h.fake.methods()).not.toContain('devices.capabilities');
});

it('refuses device target readiness on platforms without the advertised guard', () => {
  expect(() => harness({ platform: 'ios', targetReadiness: 'device' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
});

it.each(['startup', 'back', 'failed mutation', 'no-op toggle'] as const)('retains adapter readiness after %s', async (boundary) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const h = harness({ platform: 'android', targetReadiness: 'device', transition: 1500 });
  h.fake.respond('devices.capabilities', () => ({ targetReadiness: { press: 'bounded-geometry' } }));
  await boot(h, 'android');
  await h.engine.session!.restart!(operation);
  if (boundary !== 'startup') await seedPress(h);
  if (boundary === 'back') await h.engine.session!.back!(operation);
  if (boundary === 'failed mutation') {
    h.fake.respond('command.back', () => { throw new Error('back failed'); });
    await expect(h.engine.session!.back!(operation)).rejects.toThrow();
  }
  if (boundary === 'no-op toggle') {
    h.fake.respond('capture.snapshot', () => ({ nodes: [
      { ref: '@e1', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      { ref: '@e2', index: 1, parentIndex: 0, type: 'android.widget.CheckBox', label: 'Checked', identifier: 'checked', checked: true, rect: { x: 20, y: 100, width: 120, height: 40 }, hittable: true },
    ] }));
    const current = await h.engine.observe!(operation);
    const toggle = current.root.children?.flatMap((node) => node.children ?? [node]).find((node) => node.name === 'Checked')!;
    await h.engine.perform!(toggle.ref, { kind: 'check' }, operation);
  }
  h.fake.calls.length = 0;
  h.fake.respond('capture.snapshot', () => ({ nodes: [
    { ref: '@e1', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    { ref: '@e2', index: 1, parentIndex: 0, type: 'Button', label: 'Submit', identifier: 'submit', rect: { x: 20, y: 100, width: 120, height: 40 }, hittable: true },
  ] }));
  const snapshot = await h.engine.observe!(operation);
  const button = snapshot.root.children?.flatMap((node) => node.children ?? [node]).find((node) => node.name === 'Submit');
  expect(button).toBeDefined();
  const pending = h.engine.perform!(button!.ref, { kind: 'tap' }, operation);
  await setImmediate();
  expect(h.fake.methods()).not.toContain('interactions.press');
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
});
