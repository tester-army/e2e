import { describe, expect, it, vi } from 'vitest';
import { SignalLadder } from '../../src/cli/signals.ts';

/** Runs `body` with `process.send` and `process.connected` as `channel` describes, then restores both. */
function withProcessChannel<T>(channel: { readonly send: (() => boolean) | undefined; readonly connected: boolean }, body: () => T): T {
  const saved = (['send', 'connected'] as const).map((key) => [key, Object.getOwnPropertyDescriptor(process, key)] as const);
  Object.defineProperty(process, 'send', { value: channel.send, configurable: true, writable: true });
  Object.defineProperty(process, 'connected', { value: channel.connected, configurable: true, writable: true });
  try {
    return body();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(process, key);
      else Object.defineProperty(process, key, descriptor);
    }
  }
}

describe('SignalLadder', () => {
  it('interrupts on the first signal, forces on the second, exits on the third', () => {
    const exits: number[] = [];
    const ladder = new SignalLadder();
    const release = ladder.arm((code) => exits.push(code));
    try {
      process.emit('SIGINT');
      expect(ladder.interruptSignal.aborted).toBe(true);
      expect(ladder.forceSignal.aborted).toBe(false);
      expect(exits).toEqual([]);

      process.emit('SIGTERM');
      expect(ladder.forceSignal.aborted).toBe(true);
      expect(exits).toEqual([]);

      process.emit('SIGINT');
      expect(exits).toEqual([130]);
    } finally {
      release();
    }
  });

  it('escalate climbs the same rungs without a signal, for a Ctrl-C delivered as a keypress', () => {
    const exits: number[] = [];
    const ladder = new SignalLadder();
    const exit = (code: number): void => void exits.push(code);
    ladder.escalate(exit);
    expect(ladder.interruptSignal.aborted).toBe(true);
    expect(ladder.forceSignal.aborted).toBe(false);
    ladder.escalate(exit);
    expect(ladder.forceSignal.aborted).toBe(true);
    expect(exits).toEqual([]);
    ladder.escalate(exit);
    expect(exits).toEqual([130]);
  });

  it('climbs the whole ladder on its own once the parent closes its IPC channel', () => {
    vi.useFakeTimers();
    const exits: number[] = [];
    const ladder = new SignalLadder();
    const release = ladder.arm((code) => exits.push(code), 1_000);
    try {
      process.emit('disconnect');
      expect(ladder.interruptSignal.aborted).toBe(true);
      expect(ladder.forceSignal.aborted).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(ladder.forceSignal.aborted).toBe(true);
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(exits).toEqual([130]);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it.each([
    ['climbs at once when the parent was gone before it armed', { send: () => true, connected: false }, true],
    ['stays put while the parent is connected', { send: () => true, connected: true }, false],
    // Bun reports `connected: false` for a process spawned without a channel; Node.js leaves it undefined.
    ['stays put without an IPC channel, whatever connected says', { send: undefined, connected: false }, false],
  ])('%s', (_case, channel, climbs) => {
    const ladder = new SignalLadder();
    const release = withProcessChannel(channel, () => ladder.arm(() => undefined, 1_000));
    try {
      expect(ladder.interruptSignal.aborted).toBe(climbs);
    } finally {
      release();
    }
  });

  it('release removes its handlers', () => {
    const before = process.listenerCount('SIGINT');
    const disconnects = process.listenerCount('disconnect');
    const release = new SignalLadder().arm(() => undefined);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    expect(process.listenerCount('disconnect')).toBe(disconnects + 1);
    release();
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('disconnect')).toBe(disconnects);
  });
});
