/**
 * The attempt's recording, one segment per tab the
 * attempt shows. Firefox records
 * natively (`browsingContext.startScreencast`, a VP8 webm of the page's
 * repaints, which ends at the last one). Chromium's mapper
 * does not implement that command, so its segment is the CDP screencast
 * reached through the mapper's `goog:cdp` passthrough, its JPEG frames
 * encoded to VP9 webm by ffmpeg (`ensureFfmpeg`, which downloads one on first use).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EngineError, type VideoFile } from 'e2e/engine';
import { ChromiumCdp } from './cdp.ts';
import { classify, isStale, message, releaseQuietly, unlessStale } from '../errors.ts';
import type { BrowserTraits } from '../browsers.ts';
import type { BidiConnection } from './connection.ts';
import { ensureFfmpeg } from '../install/ffmpeg.ts';

/** Frames a second of the encoded video. */
const FPS = 25;

/** The recording's size and JPEG quality, as configured. */
export interface VideoOptions {
  readonly size?: { readonly width: number; readonly height: number };
  readonly quality?: number;
}

/** One segment being recorded, and how to finish it. */
interface Segment {
  readonly relative: string;
  readonly absolute: string;
  readonly startedAt: string;
  finish(): Promise<void>;
}

/**
 * The attempt's video: one segment per tab it shows, and
 * the first segment it lost. A segment that fails to start or to finish
 * never fails the step that opened or closed its tab: `stop` reports it,
 * where the harness applies the video policy.
 */
export class BidiVideo {
  private armed = false;
  private current: Segment | undefined;
  private count = 0;
  private finished: VideoFile[] = [];
  private lost: EngineError | undefined;
  /** The ffmpeg that encodes Chromium's segments, found once by the first `arm`. */
  private ffmpeg: string | undefined;
  /** Bumped by every `stop`, so a segment whose start outlived the stop ends at once instead of recording on. */
  private generation = 0;
  /** Segment starts in flight, which `stop` waits out. */
  private readonly starting = new Set<Promise<void>>();

  constructor(
    private readonly connection: BidiConnection,
    private readonly traits: BrowserTraits,
    private readonly artifactsDir: string,
    private readonly options: VideoOptions,
    /** The run's environment, which names the ffmpeg to encode with. */
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  /**
   * Starts recording `context`, unless a segment already records, and arms
   * the recorder for every tab opened after. Fails, leaving the recorder
   * disarmed, when Chromium gets no ffmpeg to encode with (it downloads one
   * on first use) or the segment cannot start.
   */
  async arm(context: string | undefined, viewport: { width: number; height: number }): Promise<void> {
    if (this.traits.screencast === 'cdp') this.ffmpeg ??= await ensureFfmpeg({ ...this.env });
    const generation = this.generation;
    if (this.current === undefined && context !== undefined) await this.tracked(this.begin(context, viewport, true));
    if (generation === this.generation) this.armed = true;
  }

  /** A tab the attempt opened: the next segment, when armed. A segment that cannot start is reported by `stop`, never here. */
  async contextOpened(context: string, viewport: { width: number; height: number }): Promise<void> {
    if (!this.armed) return;
    await this.tracked(this.begin(context, viewport, false)).catch((cause: unknown) => {
      this.lost ??= new EngineError('ENGINE_FAILURE', `video segment for a new tab could not start: ${message(cause)}`, { retryable: false, cause });
    });
  }

  /** Keeps a segment start visible to `stop` until it settles. */
  private async tracked(start: Promise<void>): Promise<void> {
    this.starting.add(start);
    try {
      await start;
    } finally {
      this.starting.delete(start);
    }
  }

  /** The recorded tab is about to close: its segment ends while it can still flush. */
  contextClosing(): Promise<void> {
    return this.end();
  }

  /**
   * Ends the recording and returns every segment written, in order. A
   * segment that was lost (its finish failed and left no file) is reported
   * instead; the segments that did
   * finalize stay on disk.
   */
  async stop(): Promise<readonly VideoFile[]> {
    this.armed = false;
    this.generation += 1;
    await Promise.allSettled(this.starting);
    await this.end();
    const lost = this.lost;
    this.lost = undefined;
    if (lost !== undefined) throw lost;
    return this.finished.splice(0);
  }

  /** Ends any segment in progress and starts the next on `context`; `arming` starts it before the recorder is armed. */
  private async begin(context: string, viewport: { width: number; height: number }, arming: boolean): Promise<void> {
    await this.end();
    const generation = this.generation;
    this.count += 1;
    const name = this.count === 1 ? 'video' : `video-part${String(this.count)}`;
    const relative = path.posix.join('video', `${name}.webm`);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const size = this.options.size ?? viewport;
    const startedAt = new Date().toISOString();
    const finish = this.traits.screencast === 'bidi'
      ? await this.bidiSegment(context, size, absolute)
      : await this.cdpSegment(context, size, absolute);
    const segment = { relative, absolute, startedAt, finish };
    if (generation !== this.generation || (!arming && !this.armed)) {
      this.current = segment;
      await this.end();
      return;
    }
    this.current = segment;
  }

  /** Ends the segment in progress. A finish that failed keeps a file it left; one that left none lost the segment, which `stop` reports. */
  private async end(): Promise<void> {
    const segment = this.current;
    this.current = undefined;
    if (segment === undefined) return;
    try {
      await segment.finish();
    } catch (cause) {
      if (!existsSync(segment.absolute)) {
        this.lost ??= new EngineError('ENGINE_FAILURE', `video segment ${segment.relative} could not be finalized: ${message(cause)}`, { retryable: false, cause });
        return;
      }
    }
    if (existsSync(segment.absolute)) this.finished.push({ path: segment.relative, startedAt: segment.startedAt });
  }

  /** The browser's own screencast (Firefox's); the file it writes is moved into the attempt directory when it stops. */
  private async bidiSegment(context: string, size: { width: number; height: number }, absolute: string): Promise<() => Promise<void>> {
    const { screencast } = await this.connection.send('browsingContext.startScreencast', {
      context,
      mimeType: 'video/webm',
      video: { width: size.width, height: size.height, frameRate: FPS },
    });
    return async () => {
      const stopped = await this.connection.send('browsingContext.stopScreencast', { screencast });
      if (stopped.error !== undefined) throw new Error(stopped.error);
      if (!existsSync(stopped.path)) throw new Error(`Firefox reported ${stopped.path}, which it never wrote`);
      try {
        renameSync(stopped.path, absolute);
      } catch {
        copyFileSync(stopped.path, absolute);
        rmSync(stopped.path, { force: true });
      }
    };
  }

  /**
   * Chromium's CDP screencast through the mapper. Each JPEG frame goes to
   * the encoder and is acknowledged once the encoder took it, so Chromium
   * sends no faster than ffmpeg encodes. A screencast sends a frame only
   * when the page repaints, and Chromium drops one that lands while the tab's
   * surface changes size, as it can when a new tab first navigates; so the
   * segment ends on a screenshot of the viewport as it stands. Everything the
   * segment acquires is released when a later step of its start fails.
   */
  private async cdpSegment(context: string, size: { width: number; height: number }, absolute: string): Promise<() => Promise<void>> {
    const ffmpeg = this.ffmpeg ??= await ensureFfmpeg({ ...this.env });
    const connection = this.connection;
    const cdp = await ChromiumCdp.forContext(connection, context);
    const encoder = new FrameEncoder(ffmpeg, size, absolute);
    let unacknowledged: unknown;
    const off = cdp.on('Page.screencastFrame', (frame) => {
      void encoder.frame(Buffer.from(frame.data, 'base64'))
        .then(() => cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }))
        .catch((cause: unknown) => {
          unacknowledged ??= cause;
        });
    });
    let subscription: string | undefined;
    try {
      subscription = await connection.subscribeExtension(['goog:cdp.Page.screencastFrame'], [context]);
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.options.quality ?? 90, maxWidth: size.width, maxHeight: size.height });
    } catch (cause) {
      off();
      if (subscription !== undefined) await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
      await releaseQuietly(encoder.abort());
      throw cause;
    }
    const subscribed = subscription;
    return async () => {
      try {
        off();
        const screen = await unlessStale(currentScreen(connection, context, this.options.quality ?? 90), undefined);
        if (screen !== undefined) await encoder.frame(screen);
        await unlessStale(cdp.send('Page.stopScreencast', {}), undefined);
        await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscribed] }));
      } finally {
        off();
        await encoder.close();
      }
      if (unacknowledged !== undefined && !isStale(unacknowledged)) throw classify(unacknowledged, 'video');
    };
  }
}

/** The tab's viewport as it stands, as a JPEG in device pixels; the encoder scales it down to the segment's size. */
async function currentScreen(connection: BidiConnection, context: string, quality: number): Promise<Buffer> {
  const { data } = await connection.send('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/jpeg', quality: quality / 100 } });
  return Buffer.from(data, 'base64');
}

/** How long the last frame holds past the end, as Playwright's recorder does: a viewer needs a moment on the final screen. */
const FRAME_GRACE_MS = 1_000;
/** How long ffmpeg gets to take the queued frames and write the file before it is killed. */
const CLOSE_TIMEOUT_MS = 10_000;
/** How much of ffmpeg's error output a failed encode reports. */
const STDERR_TAIL = 2_000;

/**
 * Encodes screencast frames to a constant-rate VP9 webm with ffmpeg. The
 * output is a timeline of `FPS` ticks from the encoder's start: a frame
 * takes the tick it arrives in, a tick a frame already took leaves the
 * newer one for the next, and a tick with no new frame repeats the last.
 * A frame larger than the output is scaled down to fit it, as the
 * screencast scales its own. Writes are serialized through ffmpeg's drain
 * cycle.
 */
class FrameEncoder {
  private readonly process: ChildProcess;
  private last: Buffer | undefined;
  private written = 0;
  private readonly startedAt = performance.now();
  private writing: Promise<void> = Promise.resolve();
  private stderr = '';
  private failure: Error | undefined;
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(ffmpeg: string, size: { width: number; height: number }, private readonly output: string) {
    const { width, height } = size;
    const args = [
      '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-y', '-an',
      '-c:v', 'libvpx-vp9', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-cpu-used', '8',
      '-b:v', '1M', '-row-mt', '1',
      '-vf', `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease,pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
      output,
    ];
    this.process = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    this.process.on('error', (cause) => {
      this.failure ??= cause;
    });
    this.process.stdin?.on('error', (cause) => {
      this.failure ??= cause;
    });
    this.exited = new Promise((resolve) => this.process.once('close', (code, signal) => resolve({ code, signal })));
  }

  /** Takes the next frame; resolves once the encoder took every frame up to it. */
  frame(jpeg: Buffer): Promise<void> {
    const due = this.due(0);
    this.fill(due);
    if (this.written === due) this.write(jpeg);
    this.last = jpeg;
    return this.writing;
  }

  /**
   * Holds the last frame until now and a moment past it, then closes the
   * input and resolves once ffmpeg wrote the file. A segment that never got
   * a frame writes none. An encoder that failed, exited nonzero, or had to be
   * killed rejects with what it said.
   */
  async close(): Promise<void> {
    if (this.last === undefined) {
      await this.abort();
      return;
    }
    const timer = setTimeout(() => this.process.kill('SIGKILL'), CLOSE_TIMEOUT_MS);
    this.fill(this.due(FRAME_GRACE_MS));
    await Promise.race([this.writing, this.exited]);
    this.process.stdin?.end();
    const { code, signal } = await this.exited.finally(() => clearTimeout(timer));
    if (this.failure !== undefined) throw new Error(`ffmpeg failed: ${this.failure.message}`);
    if (code !== 0) throw new Error(`ffmpeg ${signal === null ? `exited with ${String(code)}` : `was killed (${signal})`}${this.stderr === '' ? '' : `: ${this.stderr.trim()}`}`);
  }

  /** Kills the encoder and removes what it wrote, for a segment whose start failed. */
  async abort(): Promise<void> {
    this.process.kill('SIGKILL');
    await this.exited;
    rmSync(this.output, { force: true });
  }

  /** The tick the timeline is at now, `aheadMs` from now. */
  private due(aheadMs: number): number {
    return Math.floor(((performance.now() + aheadMs - this.startedAt) / 1000) * FPS);
  }

  /** Repeats the last frame for every tick before `due` with none. */
  private fill(due: number): void {
    if (this.last === undefined) return;
    while (this.written < due) this.write(this.last);
  }

  /** Queues one frame for the next tick. */
  private write(jpeg: Buffer): void {
    this.written += 1;
    this.writing = this.writing.then(() => this.push(jpeg));
  }

  /** Hands one frame to ffmpeg, waiting for its input to drain when full. */
  private push(jpeg: Buffer): Promise<void> | undefined {
    const stdin = this.process.stdin;
    if (stdin === null || !stdin.writable || this.failure !== undefined) return undefined;
    if (stdin.write(jpeg)) return undefined;
    return new Promise((resolve) => {
      const done = (): void => {
        stdin.off('drain', done);
        stdin.off('close', done);
        resolve();
      };
      stdin.once('drain', done);
      stdin.once('close', done);
    });
  }
}
