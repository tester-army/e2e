/**
 * The engine's one video recorder, shared by the attempt's `video` and the
 * spans a test records with `app.startRecording()` / `app.stopRecording()`.
 * Both ride the engine's `startVideo` / `stopVideo`, so only one may hold the
 * recorder at a time: a span refuses to start while the attempt's video
 * records, and the attempt's video never collects a span's segments. A span
 * is moved out of the engine's `video/` directory into `recordings/` as soon
 * as it stops, so the next span or the attempt's video never overwrites it.
 */

import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { hostedVideoUrl } from '../engine/recording.ts';
import { EngineError, type OperationContext, type TargetSession, type VideoSegment } from '../engine/surface.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import type { RecordedVideo } from '../types.ts';
import type { ArtifactSink } from './fixtures.ts';

/** A span `app.startRecording` started: its number in the attempt and its file name stem. */
interface Span {
  readonly index: number;
  readonly stem: string;
}

/** Who holds the session's recorder, and how many spans it recorded. */
class SessionRecordings {
  private holder: 'attempt' | Span | undefined;
  private spans = 0;

  constructor(
    private readonly session: TargetSession,
    private readonly targetName: string,
  ) {}

  /** True while a span records, so the attempt's end can stop it. */
  get spanRunning(): boolean {
    return this.holder !== undefined && this.holder !== 'attempt';
  }

  /**
   * Starts the attempt's video. The recorder counts as held from the call
   * on, even when the start fails: the engine may still be recording, and
   * the attempt's close stops it either way.
   */
  async startAttemptVideo(operation: OperationContext): Promise<void> {
    this.holder = 'attempt';
    await this.session.artifacts.startVideo!(operation);
  }

  /** Stops the attempt's video and returns its segments. */
  async stopAttemptVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    if (this.holder === 'attempt') this.holder = undefined;
    return this.session.artifacts.stopVideo!(operation);
  }

  /**
   * Starts a span. Refused when the engine records no video, while the
   * attempt's video records, and while another span records. A start that
   * fails is stopped, so the next one begins from nothing.
   */
  async startSpan(name: string | undefined, operation: OperationContext): Promise<void> {
    const { startVideo, stopVideo } = this.session.artifacts;
    if (startVideo === undefined || stopVideo === undefined) {
      throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `app.startRecording: target "${this.targetName}" has an engine that records no video`);
    }
    if (this.holder === 'attempt') {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `app.startRecording cannot record while the test's video records, since the engine has one recorder; set video: 'off' on the test: test('...', { video: 'off' }, ...)`,
      );
    }
    if (this.holder !== undefined) {
      throw new TestError('INVALID_ARGUMENT', 'app.startRecording: a recording is already running; await app.stopRecording() before starting another');
    }
    const index = this.spans + 1;
    const span: Span = { index, stem: `${String(index).padStart(3, '0')}-${fileStem(name)}` };
    this.holder = span;
    try {
      await startVideo(operation);
    } catch (cause) {
      this.holder = undefined;
      await stopVideo(operation).catch(() => undefined);
      throw cause;
    }
    this.spans = index;
  }

  /**
   * Stops the running span, moves its files into `recordings/`, and
   * registers each file or link as a video artifact; returns their artifact
   * ids and what the test sees, absolute paths and links in play order.
   */
  async stopSpan(operation: OperationContext, sink: ArtifactSink): Promise<{ readonly ids: readonly string[]; readonly videos: readonly [RecordedVideo, ...RecordedVideo[]] }> {
    const span = this.holder;
    if (span === undefined || span === 'attempt') {
      throw new TestError('INVALID_ARGUMENT', 'app.stopRecording: no recording is running; call app.startRecording() first');
    }
    this.holder = undefined;
    const segments = await this.session.artifacts.stopVideo!(operation);
    const ids: string[] = [];
    const videos: RecordedVideo[] = [];
    for (const [position, segment] of segments.entries()) {
      if ('url' in segment) {
        const url = hostedVideoUrl(segment.url);
        if (url === undefined) {
          throw new EngineError('ENGINE_FAILURE', `the engine returned a video link that is not an http(s) URL: ${JSON.stringify(segment.url)}`, { retryable: false });
        }
        ids.push(sink.link(url, { mediaType: segment.mediaType, startedAt: segment.startedAt }));
        videos.push({ url, mediaType: segment.mediaType, startedAt: segment.startedAt });
        continue;
      }
      const part = position === 0 ? '' : `-part${String(position + 1)}`;
      const relative = path.join('recordings', `${span.stem}${part}${path.extname(segment.path)}`);
      const absolute = path.join(sink.dir, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      renameSync(path.join(sink.dir, segment.path), absolute);
      ids.push(sink.register('video', relative, { startedAt: segment.startedAt }));
      videos.push({ path: absolute, startedAt: segment.startedAt });
    }
    const [first, ...rest] = videos;
    if (first === undefined) {
      throw new EngineError('ENGINE_FAILURE', `recording ${String(span.index)} stopped, but the engine wrote no video for it`, { retryable: false });
    }
    return { ids, videos: [first, ...rest] };
  }
}

const recordingsBySession = new WeakMap<TargetSession, SessionRecordings>();

/**
 * The recorder state of one session, created on first use and shared by
 * every attempt that borrows the session (a serial group's members).
 */
export function sessionRecordings(session: TargetSession, targetName: string): SessionRecordings {
  let recordings = recordingsBySession.get(session);
  if (recordings === undefined) {
    recordings = new SessionRecordings(session, targetName);
    recordingsBySession.set(session, recordings);
  }
  return recordings;
}

/** A recording name as a file name stem: letters, digits, `-`, and `_`, at most 64 characters. */
function fileStem(name: string | undefined): string {
  if (name !== undefined && typeof name !== 'string') {
    throw new TestError('INVALID_ARGUMENT', 'app.startRecording: name must be a string');
  }
  return (name ?? 'recording').replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'recording';
}
