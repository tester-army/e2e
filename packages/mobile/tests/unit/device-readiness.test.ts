import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { boot, harness } from '../helpers/harness.ts';

const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 5000, runId: 'r', attemptId: 'a', origin: 'test' };
afterEach(() => { vi.useRealTimers(); });

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

it('keeps the default path free of capability negotiation', async () => {
  const h = harness({ platform: 'android' });
  await boot(h, 'android');
  expect(h.fake.methods()).not.toContain('devices.capabilities');
});

it('refuses device target readiness on platforms without the advertised guard', () => {
  expect(() => harness({ platform: 'ios', targetReadiness: 'device' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
});
