/** Which attempts record and keep a video under each mode. */

import { describe, expect, it } from 'vitest';
import { attemptVideo, recordsVideo } from '../../src/run/video.ts';

describe('attemptVideo', () => {
  it('records every attempt for on and retain-on-failure, keeping all or only failures', () => {
    expect([0, 1, 2].map((index) => attemptVideo('on', index))).toEqual([{ keep: 'always' }, { keep: 'always' }, { keep: 'always' }]);
    expect(attemptVideo('retain-on-failure', 0)).toEqual({ keep: 'on-failure' });
    expect(attemptVideo('retain-on-failure', 3)).toEqual({ keep: 'on-failure' });
  });

  it('records nothing for off, and only the first retry for on-first-retry', () => {
    expect(attemptVideo('off', 0)).toBeUndefined();
    expect([0, 1, 2].map((index) => attemptVideo('on-first-retry', index))).toEqual([undefined, { keep: 'always' }, undefined]);
  });
});

describe('recordsVideo', () => {
  it('asks the engine for video only when some attempt records', () => {
    expect(recordsVideo('off', 3)).toBe(false);
    expect(recordsVideo('on', 0)).toBe(true);
    expect(recordsVideo('retain-on-failure', 0)).toBe(true);
    expect(recordsVideo('on-first-retry', 0)).toBe(false);
    expect(recordsVideo('on-first-retry', 1)).toBe(true);
  });
});
