/**
 * The attempt's recording on the Playwright surface.
 *
 * A screencast belongs to one page, so a recording is a series of segments:
 * one per page the attempt shows. `arm` starts the first segment on the
 * attempt's page; a page about to close (a restart, a context replaced by a
 * state reset) ends its segment first, since Playwright writes nothing for a
 * screencast whose page closed under it, and the next page the attempt opens
 * starts the next segment. Each segment is captured at `web({ screencast: { size } })`
 * when set, else at its page's viewport size when it starts (the window's
 * under `viewport: null`, so a page `browser.setViewport` sized is recorded at
 * that size), and carries the instant it began, so a consumer can place step
 * timestamps on it. The first segment is `video/video.webm`; later ones are
 * `video/video-part<n>.webm`. Without a recording, every hook here is a no-op.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { EngineError, type VideoFile, type VideoSegment } from 'e2e/engine';
import type { WebScreencastOptions } from './surface.ts';
import { currentViewport, message } from './support.ts';

/**
 * An attempt's video as its session drives it: armed once the attempt's page
 * is open, told when pages open and close, stopped for its segments when the
 * attempt collects its video, and abandoned when the attempt ends without
 * collecting. `VideoRecorder` is the screencast; `ProviderVideo` is the
 * browser provider's own recording.
 */
export interface AttemptVideo {
  /** True while pages the attempt opens start segments of their own. */
  readonly isArmed: boolean;
  arm(page: Page, signal: AbortSignal): Promise<void>;
  pageOpened(page: Page): Promise<void>;
  pageClosing(): Promise<void>;
  stop(signal: AbortSignal): Promise<readonly VideoSegment[]>;
  /** Ends a recording the attempt never collected; nothing it recorded is reported. */
  abandon(signal: AbortSignal): Promise<void>;
}

/** One segment in progress: the page it records, where its file lands, and whether a frame reached it yet. */
interface Segment {
  readonly page: Page;
  readonly relative: string;
  readonly absolute: string;
  readonly startedAt: string;
  /** Resolves with the segment's first frame. */
  readonly framed: Promise<void>;
}

/**
 * How long a segment that has not received a frame yet waits for one before
 * it ends. A screencast sends a frame only when the page repaints, and on
 * Linux the frame of a page that just painted arrives after the paint: a
 * segment stopped right after a navigation would otherwise end with no frame,
 * which Playwright writes as a white video.
 */
const FIRST_FRAME_WAIT_MS = 1_000;

export class VideoRecorder implements AttemptVideo {
  /** Set by `arm`, cleared by `stop`; pages the attempt opens in between start segments. */
  private armed = false;
  private current: Segment | null = null;
  /** Segments finished this attempt, in order; `stop` hands them over. */
  private finished: VideoFile[] = [];
  /** Segments started this attempt, for their file names. */
  private count = 0;
  /** The first segment whose stop failed and left no file; `stop` reports it. */
  private lost: { readonly relative: string; readonly cause: unknown } | undefined;

  constructor(
    private readonly artifactsDir: string,
    private readonly options: WebScreencastOptions = {},
  ) {}

  /** True between `arm` and `stop`: a page the attempt opens then starts a segment. */
  get isArmed(): boolean {
    return this.armed;
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

  /** The attempt closes uncollected: disarmed first, so no late page starts a segment, then the one in progress ends and its file is complete on disk. */
  abandon(): Promise<void> {
    this.armed = false;
    return this.end();
  }

  /**
   * Ends the recording and returns every segment written this attempt, in
   * order. A segment that was lost (its stop failed and left no file) is
   * reported instead: the harness records that as a cleanup failure, and the
   * segments that did finalize stay on disk.
   */
  async stop(): Promise<readonly VideoFile[]> {
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
    const { quality } = this.options;
    const size = this.options.size ?? await currentViewport(page);
    let framedOnce: () => void = () => undefined;
    const framed = new Promise<void>((resolve) => (framedOnce = resolve));
    await page.screencast.start({
      path: absolute,
      size: { width: size.width, height: size.height },
      ...(quality === undefined ? {} : { quality }),
      onFrame: () => framedOnce(),
    });
    this.current = { page, relative, absolute, startedAt: new Date().toISOString(), framed };
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
    await waitForFrame(segment, FIRST_FRAME_WAIT_MS);
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

/** Waits up to `timeoutMs` for the segment's first frame. */
async function waitForFrame(segment: Segment, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([segment.framed, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  } finally {
    clearTimeout(timer);
  }
}
