/**
 * The attempt's recording on the Playwright surface.
 *
 * A screencast belongs to one page, so a recording is a series of segments:
 * one per page the attempt shows. `arm` starts the first segment on the
 * attempt's page; a page about to close (a restart, a context replaced by a
 * state reset) ends its segment first, since Playwright writes nothing for a
 * screencast whose page closed under it, and the next page the attempt opens
 * starts the next segment. Each segment is captured at its page's viewport
 * size when it starts (the window's under `viewport: null`, so a page
 * `web.setViewport` sized is recorded at that size) and carries the instant it began, so a consumer can place step
 * timestamps on it. The first segment is `video/video.webm`; later ones are
 * `video/video-part<n>.webm`. Without a recording, every hook here is a no-op.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { EngineError, type VideoSegment } from 'e2e/engine';
import { currentViewport, message } from './support.ts';

/** One segment in progress: the page it records and where its file lands. */
interface Segment {
  readonly page: Page;
  readonly relative: string;
  readonly absolute: string;
  readonly startedAt: string;
}

export class VideoRecorder {
  /** Set by `arm`, cleared by `stop`; pages the attempt opens in between start segments. */
  private armed = false;
  private current: Segment | null = null;
  /** Segments finished this attempt, in order; `stop` hands them over. */
  private finished: VideoSegment[] = [];
  /** Segments started this attempt, for their file names. */
  private count = 0;
  /** The first segment whose stop failed and left no file; `stop` reports it. */
  private lost: { readonly relative: string; readonly cause: unknown } | undefined;

  constructor(private readonly artifactsDir: string) {}

  /** True between `arm` and `stop`: a page the attempt opens then starts a segment. */
  get isArmed(): boolean {
    return this.armed;
  }

  /** True while a segment records, so a context closing early can end it within a budget. */
  get isRecording(): boolean {
    return this.current !== null;
  }

  /** Starts the recording on `page`, unless a segment already records, and arms it. */
  async arm(page: Page): Promise<void> {
    if (this.current === null) await this.begin(page);
    this.armed = true;
  }

  /** A page the attempt opened: the next segment, when armed. */
  async pageOpened(page: Page): Promise<void> {
    if (this.armed) await this.begin(page);
  }

  /** The recorded page is about to close: its segment ends here, while the page can still flush it. */
  pageClosing(): Promise<void> {
    return this.end();
  }

  /**
   * Ends the recording and returns every segment written this attempt, in
   * order. A segment that was lost (its stop failed and left no file) is
   * reported instead: the harness records that as a cleanup failure, and the
   * segments that did finalize stay on disk.
   */
  async stop(): Promise<readonly VideoSegment[]> {
    await this.end();
    this.armed = false;
    const lost = this.lost;
    this.lost = undefined;
    if (lost !== undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `video segment ${lost.relative} could not be finalized: ${message(lost.cause)}`,
        { retryable: false, cause: lost.cause },
      );
    }
    return this.finished.splice(0);
  }

  /**
   * Starts one segment on a page, a screencast at the page's viewport size.
   * A segment still recording (a page the app closed on its own) ends first.
   */
  private async begin(page: Page): Promise<void> {
    await this.end();
    this.count += 1;
    const name = this.count === 1 ? 'video' : `video-part${String(this.count)}`;
    const relative = path.posix.join('video', `${name}.webm`);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const size = await currentViewport(page);
    await page.screencast.start({
      path: absolute,
      size: { width: size.width, height: size.height },
    });
    this.current = { page, relative, absolute, startedAt: new Date().toISOString() };
  }

  /**
   * Ends the segment in progress. A stop that failed but left a file keeps
   * the file; one that left nothing (a page closed before the stop, which
   * Playwright never flushes) lost the segment, which `stop` reports. A
   * segment that wrote nothing is not a segment.
   */
  private async end(): Promise<void> {
    const segment = this.current;
    if (segment === null) return;
    this.current = null;
    try {
      await segment.page.screencast.stop();
    } catch (cause) {
      if (!existsSync(segment.absolute)) {
        this.lost ??= { relative: segment.relative, cause };
        return;
      }
    }
    if (existsSync(segment.absolute)) {
      this.finished.push({ path: segment.relative, startedAt: segment.startedAt });
    }
  }
}
