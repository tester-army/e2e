import { describe, expect, it, vi } from 'vitest';
import { EngineError, raceAbort, type OperationContext } from 'e2e/engine';
import { sanitizeFilename, screenLocation, swipeWithin, withinBudget, withinInputBudget } from '../../src/support.ts';

describe('support helpers', () => {
  it('ends a call at its budget as OPERATION_TIMEOUT, keeps a caller abort CANCELLED, and never aborts a signal kept past the call', async () => {
    const operation = (signal = new AbortController().signal): OperationContext => ({ signal, timeoutMs: 100, runId: 'run-1', attemptId: 'a1', origin: 'test' });
    vi.useFakeTimers();
    try {
      let kept: AbortSignal | undefined;
      await withinBudget(operation(), 'read', async (bounded) => {
        kept = bounded.signal;
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(kept?.aborted).toBe(false);

      // An inner wait that reports its abort as a cancellation is still the budget's timeout.
      const hung = withinBudget(operation(), 'tap', (bounded) => raceAbort(new Promise<never>(() => undefined), bounded.signal, 'tap'));
      const timedOut = expect(hung).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'tap timed out' });
      await vi.advanceTimersByTimeAsync(100);
      await timedOut;

      const caller = new AbortController();
      const stopped = withinBudget(operation(caller.signal), 'tap', (bounded) => raceAbort(new Promise<never>(() => undefined), bounded.signal, 'tap'));
      caller.abort();
      await expect(stopped).rejects.toBeInstanceOf(EngineError);
      await expect(stopped).rejects.toMatchObject({ code: 'CANCELLED' });

      // An input with no time left to answer is never sent.
      let sent = false;
      await expect(
        withinInputBudget({ ...operation(), timeoutMs: 1 }, 'tap', async () => {
          sent = true;
        }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'tap timed out before it was sent' });
      expect(sent).toBe(false);
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
