/**
 * The recording seam every engine's provider shares: a hosted browser or
 * device service recording the attempt itself, in place of the engine's own
 * capture. A provider's `record` starts a `ProviderRecording` for the lease
 * the attempt rides; `stopProviderRecording` ends it and checks what the
 * provider handed back, so every engine turns a recording into a
 * `VideoSegment` the same way.
 */

import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { EngineError } from './contract.ts';
import type { VideoSegment } from './index.ts';

/** Handed to a provider's `record`, once per attempt that records video. */
export interface ProviderRecordContext {
  readonly runId: string;
  readonly targetName: string;
  /** The attempt the recording covers. */
  readonly attemptId: string;
  /** The run's environment, the same the provider's `acquire` saw. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the attempt is cancelled or its launch budget is spent. */
  readonly signal: AbortSignal;
}

/** Handed to `ProviderRecording.stop`, once per recording. */
export interface ProviderRecordingStopContext {
  /** Absolute directory, already created, a recording written as a file goes into. */
  readonly dir: string;
  /** Aborts when the cleanup budget is spent. */
  readonly signal: AbortSignal;
}

/**
 * What a stopped recording became: a file the provider wrote into the
 * directory it was given, by name, or a recording its service keeps, by
 * `http(s)` URL and media type.
 */
export type ProviderRecordingResult =
  | { readonly file: string }
  | { readonly url: string; readonly mediaType: string };

/** A recording a provider's service makes of the browser or device it leased, as `record` started it. */
export interface ProviderRecording {
  /** When the recording started, as an ISO timestamp; its first frame is at or just after it. */
  readonly startedAt: string;
  stop(context: ProviderRecordingStopContext): Promise<ProviderRecordingResult>;
}

/** Where the attempt's recording lands and who made it, for `stopProviderRecording`. */
export interface ProviderRecordingTarget {
  /** Absolute attempt artifact directory; a file recording goes into its `video` directory. */
  readonly artifactsDir: string;
  /** The provider as error messages name it: `browser provider "kernel"`. */
  readonly provider: string;
  /** The lease the recording covers, named in error messages. */
  readonly leaseId: string;
  readonly signal: AbortSignal;
}

/**
 * Whether `value` is a recording a provider's `record` may hand back: a
 * parseable start time and a `stop`. Every engine checks what `record`
 * resolved to with this before it keeps it, so a malformed one fails the
 * start, named, instead of the stop.
 */
export function isProviderRecording(value: unknown): value is ProviderRecording {
  if (typeof value !== 'object' || value === null) return false;
  const { startedAt, stop } = value as Partial<Record<keyof ProviderRecording, unknown>>;
  return typeof startedAt === 'string' && !Number.isNaN(Date.parse(startedAt)) && typeof stop === 'function';
}

/**
 * Ends a provider's recording and returns it as the attempt's segment: a file
 * in the attempt's `video` directory, or a link. What the provider handed back
 * is checked, since the engine trusts nothing it did not write: a file must be
 * a plain name that exists in the directory, a link an `http(s)` URL with a
 * media type. The URL is kept in its parsed form and the start time as an
 * ISO timestamp, the shapes the report schema admits. Every failure names
 * the provider and the lease.
 */
export async function stopProviderRecording(recording: ProviderRecording, target: ProviderRecordingTarget): Promise<VideoSegment> {
  const dir = path.join(target.artifactsDir, 'video');
  const what = `${target.provider} recording lease ${target.leaseId}`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw new EngineError('ENGINE_FAILURE', `${what} has no video directory to write into, ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
  }
  let result: unknown;
  try {
    result = await recording.stop({ dir, signal: target.signal });
  } catch (cause) {
    throw new EngineError('ENGINE_FAILURE', `${what} could not finish: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
  }
  const startedAt = new Date(recording.startedAt).toISOString();
  if (isWrittenFile(result, dir)) return { path: path.posix.join('video', result.file), startedAt };
  if (isLink(result)) return { url: hostedVideoUrl(result.url)!, mediaType: result.mediaType.trim(), startedAt };
  throw new EngineError('ENGINE_FAILURE', `${what} finished without naming a file it wrote into ${dir} or an http(s) URL with a media type`, { retryable: false });
}

/** A plain file name, no directory part, of a regular file in `dir`. */
function isWrittenFile(result: unknown, dir: string): result is { readonly file: string } {
  if (typeof result !== 'object' || result === null) return false;
  const { file } = result as { file?: unknown };
  if (typeof file !== 'string' || file === '' || file === '.' || file === '..' || file !== path.basename(file)) return false;
  try {
    return statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    // A name the filesystem refuses (a NUL byte) names no file the provider wrote.
    return false;
  }
}

/** An `http(s)` URL with a non-empty media type. */
function isLink(result: unknown): result is { readonly url: string; readonly mediaType: string } {
  if (typeof result !== 'object' || result === null) return false;
  const { url, mediaType } = result as { url?: unknown; mediaType?: unknown };
  return hostedVideoUrl(url) !== undefined && typeof mediaType === 'string' && mediaType.trim() !== '';
}

/** The longest URL the report admits for a hosted video, as for a failure's `url`. */
const MAX_VIDEO_URL_CHARS = 2048;

/**
 * The parsed form of an `http(s)` URL with a host, at most 2048 characters,
 * the one shape the report admits for a video a hosted service keeps;
 * undefined for anything else.
 */
export function hostedVideoUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    const hosted = (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host !== '';
    return hosted && parsed.href.length <= MAX_VIDEO_URL_CHARS ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
