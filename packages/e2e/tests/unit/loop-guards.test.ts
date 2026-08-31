import { describe, expect, it } from 'vitest';
import { checkLoopGuards, type GuardToolCall } from '../../src/agent/loop-guards.ts';

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
