import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkStepClock, instrumentPhase, retryingObserve } from '../../src/agent/phases.ts';
import type { Observation } from '../../src/engine/surface.ts';
import { Deadline } from '../../src/internal/time.ts';
import { StepRecorder } from '../../src/run/steps.ts';

/**
 * An `EngineError` the way an engine loaded from a config file throws it:
 * the right name, code, and retryability, but not an instance of the
 * harness's class, because the config module has its own registry.
 */
function foreignEngineError(code: string, retryable: boolean): Error {
  const error = new Error(`observe: ${code}`);
  error.name = 'EngineError';
  Object.assign(error, { code, retryable });
  return error;
}

const OBSERVATION: Observation = {
  kind: 'semantic',
  root: { id: 'root', revision: 'r1' },
  truncated: false,
  revision: 'b1',
  capturedAt: '2026-01-01T00:00:00.000Z',
  tree: { ref: { id: 'n1', revision: 'b1' }, role: 'document' },
  viewport: { width: 1280, height: 720 },
  redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
};

const operation = () => ({ runId: 'run', attemptId: 'attempt', timeoutMs: 1_000, signal: new AbortController().signal, origin: 'agent' as const });

describe('retryingObserve', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads after a retryable race reported by an engine from another module registry', async () => {
    vi.useFakeTimers();
    vi.setTimerTickMode('nextTimerAsync');
    let attempts = 0;
    const observation = await retryingObserve({
      observe: () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(foreignEngineError('NODE_STALE', true))
          : Promise.resolve(OBSERVATION);
      },
      operation,
      guard: () => undefined,
      signal: new AbortController().signal,
      api: 'agent.act',
      fallbackTainted: false,
    });
    expect(observation).toBe(OBSERVATION);
    expect(attempts).toBe(3);
  });

  it('surfaces a non-retryable engine failure at once', async () => {
    let attempts = 0;
    await expect(
      retryingObserve({
        observe: () => {
          attempts += 1;
          return Promise.reject(foreignEngineError('OPERATION_TIMEOUT', false));
        },
        operation,
        guard: () => undefined,
        signal: new AbortController().signal,
        api: 'agent.act',
        fallbackTainted: false,
      }),
    ).rejects.toThrow('OPERATION_TIMEOUT');
    expect(attempts).toBe(1);
  });

  it('leaves a cancelled capture to the guard when a secret fill withheld its fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retryingObserve({
        observe: () => Promise.reject(foreignEngineError('OPERATION_TIMEOUT', false)),
        operation,
        guard: () => undefined,
        signal: controller.signal,
        api: 'agent.act',
        fallbackTainted: true,
      }),
    ).rejects.toThrow('OPERATION_TIMEOUT');
  });
});

describe('instrumentPhase', () => {
  it('records the engine code of a failed phase, not the error class name', async () => {
    const steps = new StepRecorder('attempt');
    await steps
      .run('agent', 'agent.act', 'probe', async () => {
        await instrumentPhase(
          { steps },
          { api: 'agent.act', kind: 'engine', phase: 'agent.action', name: 'tap' },
          () => Promise.reject(foreignEngineError('NOT_ACTIONABLE', false)),
        ).catch(() => undefined);
        throw new Error('end the step');
      })
      .catch(() => undefined);
    const event = steps.all()[0]!.events.find((candidate) => candidate.kind === 'engine');
    expect(event?.status).toBe('failed');
    expect(event?.code).toBe('NOT_ACTIONABLE');
  });
});

describe('checkStepClock', () => {
  const check = (deadline: Deadline, cause: unknown) => () =>
    checkStepClock({ signal: new AbortController().signal, deadline, api: 'agent.waitFor', timeoutMs: 3_000, cause });
  const thrownBy = (fn: () => void): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('reads an operation timeout within a poll tick of the deadline as the deadline, with the clock still short of it', () => {
    const cause = foreignEngineError('OPERATION_TIMEOUT', false);
    const error = thrownBy(check(new Deadline(50), cause));
    expect(error).toMatchObject({ code: 'STEP_TIMEOUT', message: 'agent.waitFor exceeded its 3000 ms timeout' });
    expect((error as Error).cause).toBe(cause);
  });

  it('leaves an operation timeout with time to spare, and any other failure, to the caller', () => {
    expect(thrownBy(check(new Deadline(5_000), foreignEngineError('OPERATION_TIMEOUT', false)))).toBeUndefined();
    expect(thrownBy(check(new Deadline(50), foreignEngineError('ENGINE_FAILURE', false)))).toBeUndefined();
  });
});
