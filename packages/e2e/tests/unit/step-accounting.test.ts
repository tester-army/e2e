import { describe, expect, it } from 'vitest';
import type { OperationContext } from '../../src/engine/surface.ts';
import { Deadline } from '../../src/internal/time.ts';
import type { AgentContext } from '../../src/agent/invocation.ts';
import { StepAccounting } from '../../src/agent/step-accounting.ts';

/** The slice of a runtime accounting reads: an engine that mints operation contexts and a config with an action timeout. */
function runtime(): AgentContext {
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
  return { engine, config: { actionTimeout: 1_000 } } as unknown as AgentContext;
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
