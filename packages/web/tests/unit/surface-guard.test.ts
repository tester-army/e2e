/**
 * The surface's single operation entry, exercised without a browser: latched
 * errors fail the next step once, and cancellation is honoured before and
 * during a call.
 */

import { describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { TestError } from 'e2e/engine';
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
});
