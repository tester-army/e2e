/** The `afterStep` seam: what runs once a top-level step has passed, and what it may never change. */

import { describe, expect, it, vi } from 'vitest';
import { StepRecorder } from '../../src/run/steps.ts';

describe('afterStep', () => {
  it('runs once per top-level step, inside its scope, after the body', async () => {
    const seen: string[] = [];
    const steps: StepRecorder = new StepRecorder('a', {
      afterStep: async (record) => {
        seen.push(`${record.api}:${steps.currentStepId === record.id}`);
      },
    });
    await steps.run('app', 'app.open', '/', async () => {
      await steps.run('locator', 'screen.tap', 'x', async () => undefined);
    });
    expect(seen).toEqual(['app.open:true']);
  });

  it('is not called for a step that failed', async () => {
    const afterStep = vi.fn(async () => undefined);
    const steps = new StepRecorder('a', { afterStep });
    await expect(steps.run('app', 'app.open', '/', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(afterStep).not.toHaveBeenCalled();
  });

  it('never fails the step, whatever it throws', async () => {
    const steps = new StepRecorder('a', {
      afterStep: async () => {
        throw new Error('boom');
      },
    });
    await expect(steps.run('app', 'app.open', '/', async () => 1)).resolves.toBe(1);
    expect(steps.all()[0]?.status).toBe('passed');
  });

  it('finishes before the step reports its end', async () => {
    const order: string[] = [];
    const steps = new StepRecorder('a', {
      afterStep: async () => {
        order.push('after');
      },
      onProgress: (progress) => {
        if (progress.phase === 'end') order.push('end');
      },
    });
    await steps.run('app', 'app.open', '/', async () => undefined);
    expect(order).toEqual(['after', 'end']);
  });

  it('drops a synchronous throw too', async () => {
    const steps = new StepRecorder('a', {
      afterStep: (() => {
        throw new Error('sync boom');
      }) as never,
    });
    await expect(steps.run('app', 'app.open', '/', async () => 1)).resolves.toBe(1);
    expect(steps.all()[0]?.status).toBe('passed');
  });
});

describe('step argument', () => {
  it('records what the step was given, through the redactor, and nothing when it was given none', async () => {
    const steps = new StepRecorder('a', { redact: (text) => text.replaceAll('hunter2-value', '<secret:pw>') });
    await steps.run('locator', 'locator.fill', 'getByLabel("Note")', async () => undefined, { argument: '"says hunter2-value"' });
    await steps.run('locator', 'locator.tap', 'getByRole("button")', async () => undefined);
    expect(steps.all()[0]?.argument).toBe('"says <secret:pw>"');
    expect(steps.all()[1]).not.toHaveProperty('argument');
  });

  it('lets the running step amend its argument once it knows more, and leaves other steps alone', async () => {
    const steps = new StepRecorder('a', {});
    await steps.run('locator', 'locator.fill', 'getByLabel("Note")', async () => {
      steps.amendArgument('"ada"');
    });
    await steps.run('locator', 'locator.fill', 'getByLabel("Password")', async () => {
      steps.amendArgument('<withheld>');
    });
    steps.amendArgument('"outside"');
    expect(steps.all().map((record) => record.argument)).toEqual(['"ada"', '<withheld>']);
  });
});
