/** Which attempts keep a trace or a video under each mode, how firmly the engine is asked for the video, and one keep rule for both. */

import { describe, expect, it } from 'vitest';
import { attemptKeep, attemptVideo, keeps, recordsOnSomeAttempt } from '../../src/internal/recording-modes.ts';

const set = { source: 'run' } as const;

describe('attemptKeep', () => {
  it('keeps every attempt for on, only failures for retain-on-failure, on every attempt', () => {
    expect([0, 1, 2].map((index) => attemptKeep('on', index))).toEqual(['always', 'always', 'always']);
    expect([0, 3].map((index) => attemptKeep('retain-on-failure', index))).toEqual(['on-failure', 'on-failure']);
  });

  it('captures nothing for off, only the first retry for on-first-retry, and every retry for on-all-retries', () => {
    expect(attemptKeep('off', 0)).toBeUndefined();
    expect([0, 1, 2].map((index) => attemptKeep('on-first-retry', index))).toEqual([undefined, 'always', undefined]);
    expect([0, 1, 2].map((index) => attemptKeep('on-all-retries', index))).toEqual([undefined, 'always', 'always']);
  });
});

describe('attemptVideo', () => {
  it('records under the same keep rule, best-effort for a default mode and required for one somebody set', () => {
    expect(attemptVideo({ mode: 'retain-on-failure', ...set }, 0)).toEqual({ keep: 'on-failure', policy: 'required' });
    expect(attemptVideo({ mode: 'off', ...set }, 0)).toBeUndefined();
    expect(attemptVideo({ mode: 'on', source: 'default' }, 0)?.policy).toBe('best-effort');
    for (const source of ['run', 'target', 'test'] as const) {
      expect(attemptVideo({ mode: 'on', source }, 0)?.policy).toBe('required');
    }
  });
});

describe('keeps', () => {
  it('keeps nothing of an attempt that never ran, and under on-failure everything that did not pass, interrupted included', () => {
    const statuses = ['passed', 'failed', 'timed-out', 'interrupted', 'skipped'] as const;
    expect(statuses.map((status) => keeps('always', status))).toEqual([true, true, true, true, false]);
    expect(statuses.map((status) => keeps('on-failure', status))).toEqual([false, true, true, true, false]);
  });
});

describe('recordsOnSomeAttempt', () => {
  it('asks the engine only when some attempt records', () => {
    expect(recordsOnSomeAttempt('off', 3)).toBe(false);
    expect(recordsOnSomeAttempt('on', 0)).toBe(true);
    expect(recordsOnSomeAttempt('retain-on-failure', 0)).toBe(true);
    expect(recordsOnSomeAttempt('on-first-retry', 0)).toBe(false);
    expect(recordsOnSomeAttempt('on-first-retry', 1)).toBe(true);
    expect(recordsOnSomeAttempt('on-all-retries', 0)).toBe(false);
    expect(recordsOnSomeAttempt('on-all-retries', 2)).toBe(true);
  });
});
