/**
 * The surface's single operation entry, exercised without a browser: latched
 * errors fail the next step once, cancellation is honoured before and during
 * a call, and the cleanup helpers never outlive their budget.
 */

import { describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { TestError } from 'e2e/engine';
import { raceAbort, withinCleanupBudget } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';

function operation(signal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs: 1_000, runId: 'run', attemptId: 'a1', origin: 'test' };
}

describe('PlaywrightSurface.guard', () => {
  it('rethrows a latched error once, with its own classification, before running anything', async () => {
    const surface = new PlaywrightSurface({});
    const violation = new TestError('ACTION_FAILED', 'route handler returned without deciding');
    surface.latch.latch(violation);
    let ran = 0;
    const step = () =>
      surface.guard(operation(), 'step', async () => {
        ran += 1;
        return 'ok';
      });
    await expect(step()).rejects.toBe(violation);
    expect(ran).toBe(0);
    await expect(step()).resolves.toBe('ok');
  });

  it('refuses an already-cancelled operation as CANCELLED', async () => {
    const surface = new PlaywrightSurface({});
    const controller = new AbortController();
    controller.abort();
    await expect(surface.guard(operation(controller.signal), 'step', async () => 1)).rejects.toMatchObject({
      code: 'CANCELLED',
      retryable: false,
    });
  });

  it('stops waiting on a call once the operation aborts mid-flight', async () => {
    const surface = new PlaywrightSurface({});
    const controller = new AbortController();
    const pending = surface.guard(
      operation(controller.signal),
      'step',
      () => new Promise<never>(() => undefined),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports a missing attempt as INVALID_STATE', () => {
    const surface = new PlaywrightSurface({});
    expect(() => surface.requireContext()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => surface.requirePage()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });
});

describe('raceAbort', () => {
  it('absorbs the late rejection of an abandoned call', async () => {
    const controller = new AbortController();
    let reject!: (cause: unknown) => void;
    const abandoned = new Promise<never>((_resolve, r) => {
      reject = r;
    });
    const raced = raceAbort(abandoned, controller.signal, 'call');
    controller.abort();
    await expect(raced).rejects.toMatchObject({ code: 'CANCELLED' });
    reject(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('withinCleanupBudget', () => {
  it('resolves when the work settles, when the budget aborts, or when it elapses', async () => {
    await expect(withinCleanupBudget(Promise.reject(new Error('close failed')), { signal: new AbortController().signal, timeoutMs: 1_000 })).resolves.toBeUndefined();

    const aborted = new AbortController();
    const never = new Promise<never>(() => undefined);
    const waiting = withinCleanupBudget(never, { signal: aborted.signal, timeoutMs: 60_000 });
    aborted.abort();
    await expect(waiting).resolves.toBeUndefined();

    await expect(withinCleanupBudget(never, { signal: new AbortController().signal, timeoutMs: 5 })).resolves.toBeUndefined();
  });
});
