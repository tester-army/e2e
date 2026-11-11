import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentDeviceClient } from 'agent-device';
import { describe, expect, it, vi } from 'vitest';
import { InputBudget, sanitizeFilename, screenLocation, swipeWithin } from '../../src/support.ts';

describe('support helpers', () => {
  it('sends an input with what is left of its budget, and reports one cut off as possibly committed', async () => {
    const hung = () => new Promise<never>(() => undefined);
    vi.useFakeTimers();
    try {
      const cut = new InputBudget('tap', 300, (pending) => pending, new AbortController().signal).send(hung);
      const committed = expect(cut).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      await vi.advanceTimersByTimeAsync(300);
      await committed;

      // Sent with almost nothing left, a tap still gets time to answer.
      const late = new InputBudget('tap', 10, (pending) => pending, new AbortController().signal).send(() => new Promise((resolve) => setTimeout(() => resolve('tapped'), 200)));
      await vi.advanceTimersByTimeAsync(200);
      await expect(late).resolves.toBe('tapped');

      // A spent budget sends nothing; after an input went out, the next one is refused as possibly committed.
      const spent = new InputBudget('tap', 100, (pending) => pending, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(100);
      let dispatched = false;
      await expect(spent.send(async () => (dispatched = true))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'tap timed out before it was sent' });
      expect(dispatched).toBe(false);
      const twoStep = new InputBudget('press', 100, (pending) => pending, new AbortController().signal);
      await twoStep.send(async () => undefined);
      await vi.advanceTimersByTimeAsync(100);
      await expect(twoStep.send(async () => undefined)).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });

      // A command that throws before it is sent does not count as sent.
      const refused = new InputBudget('press', 100, (pending) => pending, new AbortController().signal);
      expect(() => refused.send(() => {
        throw new Error('no target');
      })).toThrow('no target');
      await vi.advanceTimersByTimeAsync(100);
      await expect(refused.send(async () => undefined)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });

      // A hold the budget cannot cover is refused unsent, with the reason.
      let held = false;
      await expect(new InputBudget('longPress', 2_000, (pending) => pending, new AbortController().signal).send(async () => (held = true), 3_000)).rejects.toMatchObject({
        code: 'NOT_ACTIONABLE',
        message: expect.stringMatching(/^longPress holds for 3000 ms, but only 2000 ms of its timeout are left/),
      });
      expect(held).toBe(false);

    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a read with what is left of its budget, and reports one cut off after an input as possibly committed', async () => {
    const hung = () => new Promise<never>(() => undefined);
    vi.useFakeTimers();
    try {
      await expect(new InputBudget('snapshot', 300, (pending) => pending, new AbortController().signal).read(async () => 'tree')).resolves.toBe('tree');

      const cut = new InputBudget('snapshot', 200, (pending) => pending, new AbortController().signal).read(hung);
      const timedOut = expect(cut).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'snapshot timed out before the device answered' });
      await vi.advanceTimersByTimeAsync(200);
      await timedOut;

      const spent = new InputBudget('snapshot', 100, (pending) => pending, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(100);
      await expect(spent.read(async () => 'late')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'snapshot timed out before it was sent' });

      // After a swipe went out, a read that does not answer must not let a replay send the swipe again.
      const dismissal = new InputBudget('keyboard dismiss', 300, (pending) => pending, new AbortController().signal);
      await dismissal.send(async () => undefined);
      const after = dismissal.read(hung);
      const committed = expect(after).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      await vi.advanceTimersByTimeAsync(300);
      await committed;
      await expect(dismissal.read(async () => 'late')).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the app and the screen title as a location that is not a URL', () => {
    expect(screenLocation('com.apple.Preferences', 'General')).toBe('com.apple.Preferences / General');
    expect(screenLocation('com.apple.Preferences', undefined)).toBe('com.apple.Preferences');
    expect(screenLocation(undefined, 'General')).toBe('General');
    expect(screenLocation(undefined, undefined)).toBeUndefined();
    expect(screenLocation('My App', ' Wi-Fi  Settings ')).toBe('My App / Wi-Fi Settings');
    // Two apps with a screen of the same name never share a location.
    expect(screenLocation('com.apple.Preferences', 'General')).not.toBe(screenLocation('com.example.other', 'General'));
    // The harness applies its origin policy to anything that parses as a URL; a device location must not.
    expect(URL.canParse(screenLocation('com.apple.Preferences', 'General')!)).toBe(false);
  });

  it('swipes against the scroll direction inside the rect', () => {
    const rect = { x: 0, y: 100, width: 200, height: 400 };
    expect(swipeWithin(rect, 'down', undefined)).toEqual({ from: { x: 100, y: 400 }, to: { x: 100, y: 200 } });
    expect(swipeWithin(rect, 'up', 'fast')).toEqual({ from: { x: 100, y: 140 }, to: { x: 100, y: 460 } });
    expect(swipeWithin(rect, 'right', 'slow')).toEqual({ from: { x: 125, y: 300 }, to: { x: 75, y: 300 } });
    expect(swipeWithin(rect, 'left', undefined)).toEqual({ from: { x: 50, y: 300 }, to: { x: 150, y: 300 } });
  });

  it('constrains labels to safe filenames', () => {
    expect(sanitizeFilename('after checkout/1')).toBe('after_checkout_1');
    expect(sanitizeFilename('')).toBe('artifact');
    expect(sanitizeFilename('x'.repeat(100))).toHaveLength(64);
  });
});

it.each(['press', 'type'] as const)('preserves the acknowledgement allowance for %s at the SDK boundary', async (command) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'e2e-input-ack-'));
  let delivered = 0;
  const client = createAgentDeviceClient({ session: 'input-ack', stateDir }, {
    transport: async (request) => {
      delivered += 1;
      await new Promise((resolve) => setTimeout(resolve, 180));
      return request.command === 'type'
        ? { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'Typing is unavailable' } }
        : { ok: true, data: {} };
    },
  });
  const budget = new InputBudget(command, 100, (pending) => pending, new AbortController().signal);
  try {
    if (command === 'press') {
      await expect(budget.send((signal) => client.interactions.press({ x: 20, y: 20, signal }))).resolves.toBeDefined();
    } else {
      await expect(budget.send((signal) => client.interactions.type({ text: 'hello', signal }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', message: 'Typing is unavailable' });
    }
    expect(delivered).toBe(1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it('keeps caller cancellation on later inputs from the same operation', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'e2e-input-operation-cancel-'));
  const controller = new AbortController();
  let release!: () => void;
  let markStarted!: () => void;
  let markFinished!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const finished = new Promise<void>((resolve) => { markFinished = resolve; });
  let requests = 0;
  let delivered = 0;
  const client = createAgentDeviceClient({ session: 'operation-cancel', stateDir }, {
    transport: async (_request, context) => {
      requests += 1;
      if (requests === 2) {
        markStarted();
        await held;
      }
      if (context?.signal?.aborted !== true) delivered += 1;
      if (requests === 2) markFinished();
      return { ok: true, data: {} };
    },
  });
  const budget = new InputBudget('tap', 30000, (pending) => pending, controller.signal);
  try {
    await budget.send((signal) => client.interactions.press({ x: 20, y: 20, signal }));
    const second = budget.send((signal) => client.interactions.press({ x: 30, y: 30, signal }));
    const canceled = expect(second).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
    await started;
    controller.abort();
    await canceled;
    release();
    await finished;
    expect(delivered).toBe(1);
  } finally {
    release();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
