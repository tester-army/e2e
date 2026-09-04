import { describe, expect, it } from 'vitest';
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

  it('release removes its handlers', () => {
    const before = process.listenerCount('SIGINT');
    const release = new SignalLadder().arm(() => undefined);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    release();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
