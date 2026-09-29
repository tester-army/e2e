/**
 * The runner's side of video: which attempts record and which recordings are
 * kept, from a `VideoMode` and the attempt's place in the retry loop.
 */

import type { VideoMode } from '../types.ts';

/** What one attempt records: which of its recordings are kept once its verdict is in. */
export interface AttemptVideo {
  readonly keep: 'always' | 'on-failure';
}

/** What an attempt at `attemptIndex` (0 for the first run, 1 for the first retry) records under `mode`; undefined records nothing. */
export function attemptVideo(mode: VideoMode, attemptIndex: number): AttemptVideo | undefined {
  switch (mode) {
    case 'off':
      return undefined;
    case 'on':
      return { keep: 'always' };
    case 'retain-on-failure':
      return { keep: 'on-failure' };
    case 'on-first-retry':
      return attemptIndex === 1 ? { keep: 'always' } : undefined;
  }
}

/** Whether any attempt of a test with `retries` records under `mode`: what the engine has to be able to honour before the run starts. */
export function recordsVideo(mode: VideoMode, retries: number): boolean {
  return mode === 'on-first-retry' ? retries >= 1 : mode !== 'off';
}
