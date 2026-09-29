/**
 * The recording modes `trace` and `video` share, in one place for every
 * check that reads one (the config, a target, a test, `--trace`, `--video`),
 * and the one per-attempt decision both recordings follow: which attempts
 * record, which recordings are kept, and how firmly the engine is asked.
 */

import type { RecordingMode } from '../types.ts';

export const RECORDING_MODES: readonly RecordingMode[] = ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries'];

/** The recordings a mode chooses attempts for. */
export type RecordingKind = 'trace' | 'video';

/**
 * Where an effective mode was set. `default`: nobody set it. `run`: the
 * config root or the CLI flag, which apply to every target whose engine can
 * record the kind. `target` and `test`: set for that target or test, so the
 * engine must be able to record it.
 */
export type RecordingSource = 'default' | 'run' | 'target' | 'test';

/** One effective mode and where it came from. */
export interface ResolvedRecording {
  readonly mode: RecordingMode;
  readonly source: RecordingSource;
}

/**
 * What one attempt records of one kind. `keep` says which recordings survive
 * the verdict. `policy` says what a recording that fails to start or finalize
 * does: `best-effort` (a default mode) drops it quietly, `required` (a mode
 * someone set) fails the attempt's launch or cleanup.
 */
export interface AttemptRecording {
  readonly keep: 'always' | 'on-failure';
  readonly policy: 'best-effort' | 'required';
}

/** Both recordings of one attempt; undefined records nothing of that kind. */
export interface AttemptRecordings {
  readonly trace: AttemptRecording | undefined;
  readonly video: AttemptRecording | undefined;
}

/** Whether `value` is one of `RECORDING_MODES`. */
export function isRecordingMode(value: unknown): value is RecordingMode {
  return (RECORDING_MODES as readonly unknown[]).includes(value);
}

/**
 * An old trace spelling and the mode it meant, for the message that refuses
 * it: `'all'` (every attempt, the removed `artifacts.trace.record: 'all'`)
 * is `'on'`, and `'retries'` is `'on-all-retries'`, bare or as the block
 * `{ record }` lifted to where a mode goes now. `was` spells the value as
 * written. Undefined for anything else.
 */
export function legacyTraceSpelling(value: unknown): { readonly was: string; readonly mode: RecordingMode } | undefined {
  const block = typeof value === 'object' && value !== null && !Array.isArray(value);
  const record = block ? (value as { record?: unknown }).record : value;
  const mode = record === 'retries' ? 'on-all-retries' : record === 'all' ? 'on' : undefined;
  if (mode === undefined) return undefined;
  return { was: block ? `{ record: '${record}' }` : `'${record}'`, mode };
}

/** Whether a mode records retries only, so a test with no retries records nothing under it. */
export function isRetryMode(mode: RecordingMode): boolean {
  return mode === 'on-first-retry' || mode === 'on-all-retries';
}

/** What an attempt at `attemptIndex` (0 for the first run, 1 for the first retry) records under `recording`; undefined records nothing. */
export function attemptRecording(recording: ResolvedRecording, attemptIndex: number): AttemptRecording | undefined {
  const policy = recording.source === 'default' ? 'best-effort' : 'required';
  switch (recording.mode) {
    case 'off':
      return undefined;
    case 'on':
      return { keep: 'always', policy };
    case 'retain-on-failure':
      return { keep: 'on-failure', policy };
    case 'on-first-retry':
      return attemptIndex === 1 ? { keep: 'always', policy } : undefined;
    case 'on-all-retries':
      return attemptIndex >= 1 ? { keep: 'always', policy } : undefined;
  }
}

/** Whether any attempt of a test with `retries` records under `mode`: what the engine has to be able to honour before the run starts. */
export function recordsOnSomeAttempt(mode: RecordingMode, retries: number): boolean {
  return isRetryMode(mode) ? retries >= 1 : mode !== 'off';
}
