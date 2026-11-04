import { describe, expect, it, vi } from 'vitest';
import { SignalLadder } from '../../src/cli/signals.ts';

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

  it('climbs at once when the parent was gone before it armed', () => {
    const connected = Object.getOwnPropertyDescriptor(process, 'connected');
    Object.defineProperty(process, 'connected', { value: false, configurable: true });
    const ladder = new SignalLadder();
    const release = ladder.arm(() => undefined, 1_000);
    try {
      expect(ladder.interruptSignal.aborted).toBe(true);
    } finally {
      release();
      if (connected === undefined) Reflect.deleteProperty(process, 'connected');
      else Object.defineProperty(process, 'connected', connected);
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
