import { describe, expect, it } from 'vitest';
import { DebugTrace } from '../../src/internal/debug.ts';

describe('DebugTrace', () => {
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
});
