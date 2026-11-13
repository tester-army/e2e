import { describe, expect, it, vi } from 'vitest';
import { Deadline } from 'e2e-core/lib/internal/time';
import { AttemptBudget } from 'e2e-core/lib/run/budget';
import { AttemptHolds } from '../../src/run/step-hold.ts';

describe('AttemptHolds', () => {
  it('times the body out at a hold that comes past the deadline, without asking', async () => {
    const signal = new AbortController().signal;
    const ask = vi.fn(() => new Promise<void>(() => {}));
    const holds = new AttemptHolds({ budget: new AttemptBudget(signal, new Deadline(20)), signal, ask, onResume: () => {} });
    const body = holds.race(new Promise<never>(() => {}), () => new Error('timed out'));
    // Synchronous work blocks the event loop past the deadline, so its timer never fires.
    const end = Date.now() + 40;
    while (Date.now() < end) {}
    await holds.hold({ api: 'app.open', label: '/' }, signal);
    await expect(body).rejects.toThrow('timed out');
    expect(ask).not.toHaveBeenCalled();
  });
});
