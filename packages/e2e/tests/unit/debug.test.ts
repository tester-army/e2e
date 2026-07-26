import { describe, expect, it } from 'vitest';
import { DebugTrace } from '../../src/internal/debug.ts';

describe('DebugTrace', () => {
  it('aggregates count, total, and max per label', () => {
    const trace = new DebugTrace(true);
    trace.record('session.launch', 100);
    trace.record('session.launch', 300);
    trace.record('collect', 50);
    const summary = trace.summary();
    expect(summary).toContain('session.launch');
    expect(summary).toContain('collect');
    expect(summary).toMatch(/session\.launch\s+2\s+400ms\s+200ms\s+300ms/);
  });

  it('times async work and rethrows failures', async () => {
    const trace = new DebugTrace(true);
    const value = await trace.time('ok', async () => 42);
    expect(value).toBe(42);
    await expect(trace.time('fails', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    const summary = trace.summary();
    expect(summary).toContain('ok');
    expect(summary).toContain('fails');
  });

  it('records nothing when disabled', async () => {
    const trace = new DebugTrace(false);
    trace.record('label', 10);
    await trace.time('other', async () => undefined);
    expect(trace.enabled).toBe(false);
    expect(trace.summary()).toContain('(no phases recorded)');
  });

  it('sorts the summary by total time descending', () => {
    const trace = new DebugTrace(true);
    trace.record('small', 1);
    trace.record('large', 1000);
    const summary = trace.summary();
    expect(summary.indexOf('large')).toBeLessThan(summary.indexOf('small'));
  });
});
