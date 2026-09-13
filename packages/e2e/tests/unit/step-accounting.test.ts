import { describe, expect, it } from 'vitest';
import type { OperationContext } from '../../src/engine/surface.ts';
import { Deadline } from '../../src/internal/time.ts';
import type { AgentContext } from '../../src/agent/invocation.ts';
import { StepAccounting } from '../../src/agent/step-accounting.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { MAX_REASONING_CHARS } from '../../src/agent/usage.ts';

/** The slice of a runtime accounting reads: an engine that mints operation contexts and a config with an action timeout. */
function runtime(): AgentContext & { steps: StepRecorder } {
  const signal = new AbortController().signal;
  const engine = {
    signal,
    deadline: (timeoutMs: number) => new Deadline(timeoutMs),
    operation: (timeoutMs?: number): OperationContext => ({
      signal,
      timeoutMs: timeoutMs ?? 1_000,
      runId: 'run-1',
      attemptId: 'a1',
      origin: 'test',
    }),
  };
  return { engine, config: { actionTimeout: 1_000 }, steps: new StepRecorder('attempt'), redact: (text: string) => text.replaceAll('s3cret', '[redacted]') } as unknown as AgentContext & {
    steps: StepRecorder;
  };
}

describe('step accounting operation contexts', () => {
  it('marks actions as the agent\'s, and as the test\'s while a trace replays', () => {
    const accounting = new StepAccounting(runtime(), {
      api: 'agent.act',
      timeoutMs: 10_000,
      maxActions: 5,
      maxModelCalls: 5,
      contextBytes: 0,
    });
    expect(accounting.actionOperation().origin).toBe('agent');
    expect(accounting.operation().origin).toBe('agent');
    accounting.replaying(true);
    // Both contexts: targeted actions take actionOperation(), navigation takes operation().
    expect(accounting.actionOperation().origin).toBe('test');
    expect(accounting.operation().origin).toBe('test');
    accounting.replaying(false);
    expect(accounting.actionOperation().origin).toBe('agent');
    expect(accounting.operation().origin).toBe('agent');
  });
});

describe('step accounting model reasoning', () => {
  function accountingWithSteps(): { accounting: StepAccounting; steps: StepRecorder } {
    const context = runtime();
    return {
      accounting: new StepAccounting(context, {
        api: 'agent.act',
        timeoutMs: 10_000,
        maxActions: 5,
        maxModelCalls: 5,
        contextBytes: 0,
      }),
      steps: context.steps,
    };
  }

  it('records a call\'s reasoning on its model event, bounded to the schema cap', async () => {
    const { accounting, steps } = accountingWithSteps();
    await steps.run('agent', 'agent.act', 'probe', async () => {
      accounting.recordModelCall({ inputTokens: 1, outputTokens: 1, reasoning: 'closing the modal first' });
      accounting.recordModelCall({ inputTokens: 1, outputTokens: 1, reasoning: ` ${'x'.repeat(5_000)} ` });
      accounting.recordModelCall({ inputTokens: 1, outputTokens: 1, reasoning: '   ' });
    });
    const events = steps.all()[0]!.events.filter((event) => event.kind === 'model');
    expect(events[0]!.reasoning).toBe('closing the modal first');
    expect(events[1]!.reasoning).toBe(`${'x'.repeat(MAX_REASONING_CHARS - 1)}…`);
    expect(events[2]).not.toHaveProperty('reasoning');
  });

  it('runs the attempt redactor over the reasoning excerpt', async () => {
    const { accounting, steps } = accountingWithSteps();
    await steps.run('agent', 'agent.act', 'probe', async () => {
      accounting.recordModelCall({ inputTokens: 1, outputTokens: 1, reasoning: 'the field held s3cret' });
    });
    const event = steps.all()[0]!.events.find((candidate) => candidate.kind === 'model');
    expect(event?.reasoning).toBe('the field held [redacted]');
  });
});
