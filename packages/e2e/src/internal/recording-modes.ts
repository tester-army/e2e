/**
 * The modes `trace` and `video` share, in one place for every check that
 * reads one (the config, a target, a test, `--trace`, `--video`), and the
 * one per-attempt decision both follow: which attempts keep what they
 * captured. Only the video is an engine recording with a start and a stop;
 * the trace is the runner's own record of the attempt, on every engine.
 */

import type { RecordingMode } from '../types.ts';

export const RECORDING_MODES: readonly RecordingMode[] = ['off', 'on', 'retain-on-failure', 'on-first-retry', 'on-all-retries'];

/** The two settings a mode is resolved for. */
export type RecordingKind = 'trace' | 'video';

/**
 * Where an effective mode was set. `default`: nobody set it. `run`: the
 * config root or the CLI flag, which apply to every target whose engine can
 * record video. `target` and `test`: set for that target or test, so the
 * engine must be able to record the video it asks for.
 */
export type RecordingSource = 'default' | 'run' | 'target' | 'test';

/** One effective mode and where it came from. */
export interface ResolvedRecording {
  readonly mode: RecordingMode;
  readonly source: RecordingSource;
}

/** Which attempts keep what they captured: every one, or only one that ran and did not pass. */
export type Keep = 'always' | 'on-failure';

/**
 * The video one attempt records. `policy` says what a recording that fails
 * to start or finalize does: `best-effort` (a default mode) drops it
 * quietly, `required` (a mode someone set) fails the attempt's launch or
 * cleanup.
 */
export interface VideoRecording {
  readonly keep: Keep;
  readonly policy: 'best-effort' | 'required';
}

/** What one attempt captures: the trace's keep rule and the video; undefined captures nothing of that kind. */
export interface AttemptRecordings {
  readonly trace: Keep | undefined;
  readonly video: VideoRecording | undefined;
}

/**
 * Whether an attempt that ended `status` keeps what it captured under
 * `keep`: nothing of an attempt that never ran (skipped), and under
 * `on-failure` only one that did not pass, interrupted ones included, since
 * where it stopped is what a reader is after. One rule for the trace and the
 * video alike.
 */
export function keeps(keep: Keep, status: 'passed' | 'failed' | 'timed-out' | 'interrupted' | 'skipped'): boolean {
  if (status === 'skipped') return false;
  return keep === 'always' || status !== 'passed';
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

/** Which attempts keep what they capture under `mode`, for the attempt at `attemptIndex` (0 for the first run, 1 for the first retry); undefined captures nothing. */
export function attemptKeep(mode: RecordingMode, attemptIndex: number): Keep | undefined {
  switch (mode) {
    case 'off':
      return undefined;
    case 'on':
      return 'always';
    case 'retain-on-failure':
      return 'on-failure';
    case 'on-first-retry':
      return attemptIndex === 1 ? 'always' : undefined;
    case 'on-all-retries':
      return attemptIndex >= 1 ? 'always' : undefined;
  }
}

/** The video an attempt at `attemptIndex` records under `recording`; undefined records none. */
export function attemptVideo(recording: ResolvedRecording, attemptIndex: number): VideoRecording | undefined {
  const keep = attemptKeep(recording.mode, attemptIndex);
  return keep === undefined ? undefined : { keep, policy: recording.source === 'default' ? 'best-effort' : 'required' };
}

/** Whether any attempt of a test with `retries` records under `mode`: what the engine has to be able to honour before the run starts. */
export function recordsOnSomeAttempt(mode: RecordingMode, retries: number): boolean {
  return isRetryMode(mode) ? retries >= 1 : mode !== 'off';
}
