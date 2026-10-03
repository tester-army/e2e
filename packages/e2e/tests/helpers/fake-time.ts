import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Runs every test in the calling file on fake timers that advance on their own
 * whenever the test awaits, so retry budgets, poll intervals, and negation
 * grace periods elapse instantly. `Date` and `performance` move with the
 * clock, so elapsed-time assertions still measure what the product waited.
 */
export function useFakeTime(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setTimerTickMode('nextTimerAsync');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
