import { describe, expect, it } from 'vitest';
import type { ModelMessage, ToolResultPart } from 'ai';
import {
  checkFailureStreak,
  checkLoopGuards,
  DEFAULT_LOOP_GUARD_THRESHOLDS,
  extractToolResults,
  type GuardToolCall,
  type GuardToolResult,
  isFailedResult,
} from '../../src/agent/loop-guards.ts';

const call = (toolName: string, input = '{}'): GuardToolCall => ({ toolName, input });

describe('loop guards', () => {
  it('stays clear on varied work', () => {
    const calls = [
      call('tap', '{"target":"n1"}'),
      call('type', '{"target":"n2","value":"a"}'),
      call('tap', '{"target":"n3"}'),
      call('observe'),
      call('tap', '{"target":"n4"}'),
    ];
    expect(checkLoopGuards(calls).kind).toBe('clear');
  });

  it('warns on three identical calls and stops on five', () => {
    const repeated = (count: number) =>
      Array.from({ length: count }, () => call('tap', '{"target":"n1"}'));
    expect(checkLoopGuards([call('observe'), ...repeated(2)]).kind).toBe('clear');
    const warned = checkLoopGuards([call('observe'), ...repeated(3)]);
    expect(warned.kind).toBe('warn');
    const stopped = checkLoopGuards([call('observe'), ...repeated(5)]);
    expect(stopped.kind).toBe('stop');
    expect((stopped as { reason: string }).reason).toContain('"tap"');
  });

  it('identical inputs are required: alternating targets are not a repeat', () => {
    const calls = Array.from({ length: 8 }, (_, index) =>
      call('tap', `{"target":"n${index}"}`),
    );
    expect(checkLoopGuards(calls).kind).toBe('clear');
  });

  it('detects a two-call cycle: warn at two repetitions, stop at three', () => {
    const pair = [call('tap', '{"target":"a"}'), call('tap', '{"target":"b"}')];
    expect(checkLoopGuards([...pair, ...pair]).kind).toBe('warn');
    const stopped = checkLoopGuards([...pair, ...pair, ...pair]);
    expect(stopped.kind).toBe('stop');
    expect((stopped as { reason: string }).reason).toContain('2-call sequence');
  });

  it('detects a three-call cycle with an observe interleaved', () => {
    const cycle = [
      call('tap', '{"target":"expense"}'),
      call('tap', '{"target":"zone"}'),
      call('observe'),
    ];
    expect(checkLoopGuards([...cycle, ...cycle, ...cycle]).kind).toBe('stop');
  });

  it('a uniform window is owned by the period-1 policy, not reported as a cycle', () => {
    // Four identical calls: period 2 would call this two cycle repetitions
    // (stop threshold not met), but period 1 warns — the stricter, correct read.
    const calls = Array.from({ length: 4 }, () => call('tap', '{"target":"n1"}'));
    const verdict = checkLoopGuards(calls);
    expect(verdict.kind).toBe('warn');
    expect((verdict as { reason: string }).reason).toContain('4 times in a row');
  });
});

describe('checkLoopGuards thresholds', () => {
  it('honors caller thresholds over the defaults', () => {
    const calls = Array.from({ length: 2 }, () => call('tap', '{"target":"n1"}'));

    expect(checkLoopGuards(calls).kind).toBe('clear');
    expect(checkLoopGuards(calls, { ...DEFAULT_LOOP_GUARD_THRESHOLDS, repeatWarn: 2 }).kind).toBe('warn');
    expect(checkLoopGuards(calls, { ...DEFAULT_LOOP_GUARD_THRESHOLDS, repeatWarn: 1, repeatStop: 2 }).kind).toBe('stop');
  });
});

describe('failure streak', () => {
  const failed = 'Tapped #n6. failed: node #n6 is not on the current screen (observation b3); it was removed or never existed\n\nCurrent screen (revision b3, 2 nodes):\n#n1 document\n #n2 heading "X"';
  const tapped = 'Tapped #n6.\n\nScreen unchanged since revision b3 (2 nodes).';

  it('recognizes every failure shape a tool result takes, and nothing else', () => {
    expect(isFailedResult(failed)).toBe(true);
    expect(isFailedResult('Action failed: the step budget is spent')).toBe(true);
    expect(isFailedResult('Tool "seed" failed: connection refused')).toBe(true);
    expect(isFailedResult(tapped)).toBe(false);
    // Text the model typed is not a failure, even when it reads like one.
    expect(isFailedResult('Typed "failed: no" into #n3.\n\nScreen unchanged since revision b3 (2 nodes).')).toBe(false);
  });

  const failure: GuardToolResult = { text: failed, failed: true };
  const success: GuardToolResult = { text: tapped, failed: false };

  it('warns at three failures in a row, stops at five, and starts over after a success', () => {
    const streak = (count: number) => Array.from({ length: count }, () => failure);
    expect(checkFailureStreak(streak(2)).kind).toBe('clear');
    const warned = checkFailureStreak([success, ...streak(3)]);
    expect(warned.kind).toBe('warn');
    expect((warned as { reason: string }).reason).toBe('the last 3 actions failed in a row');
    expect(checkFailureStreak(streak(5)).kind).toBe('stop');
    expect(checkFailureStreak([...streak(4), success, ...streak(2)]).kind).toBe('clear');
  });

  it('reads text results for the failure shape, counts a call the SDK refused as failed, and skips the conclusion tool and structured results', () => {
    const result = (toolName: string, output: ToolResultPart['output']): ModelMessage => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: toolName, toolName, output }],
    });
    // What the SDK hands back for an input outside the closed schema and for a tool the step does not offer.
    const undeclaredField = 'Invalid input for tool tap: Type validation failed: Value: {"target":"n6","force":true}.\nError message: [{"code":"unrecognized_keys","keys":["force"],"path":[],"message":"Unrecognized key: \\"force\\""}]';
    const unknownTool = "Model tried to call unavailable tool 'click'. Available tools: observe, tap, type, complete_step.";
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Execute this test step' },
      result('tap', { type: 'text', value: failed }),
      result('lookup', { type: 'json', value: { rows: 3 } }),
      result('complete_step', { type: 'text', value: 'Action failed: summary too long' }),
      result('tap', { type: 'error-text', value: undeclaredField }),
      result('click', { type: 'error-text', value: unknownTool }),
      result('tap', { type: 'text', value: tapped }),
    ];
    expect(extractToolResults(messages, 'complete_step')).toEqual([
      failure,
      { text: undeclaredField, failed: true },
      { text: unknownTool, failed: true },
      success,
    ]);
  });
});
