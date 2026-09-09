/**
 * The attempt's recording on the Playwright surface.
 *
 * A screencast belongs to one page, so a recording is a series of segments:
 * one per page the attempt's contexts open. `arm` starts the first segment on
 * the attempt's page; a context replaced mid-attempt (a restart, a state
 * reset) ends the segment with the old page, and the new context's first page
 * starts the next. Each segment is captured at the attempt's viewport size and
 * carries the instant it began, so a consumer can place step timestamps on it.
 * The first segment is `video/video.webm`; later ones are
 * `video/video-part<n>.webm`.
 *
 * The recorder also owns the pointer the frames show: it is installed on every
 * recorded page, follows pointer actions while the recording is armed, and is
 * hidden while model-facing pixels and evidence screenshots are captured.
 * Without a recording, every hook here is a no-op.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { LocatorAction, VideoSegment } from '@e2edev/e2e/engine';
import { installCursorOverlay, withCursorFollowing, withCursorHidden } from './cursor-overlay.ts';
import type { ActionTarget } from './support.ts';

/** One segment in progress: the page it records and where its file lands. */
interface Segment {
  readonly page: Page;
  readonly relative: string;
  readonly absolute: string;
  readonly startedAt: string;
}

export class VideoRecorder {
  private readonly viewport: { readonly width: number; readonly height: number };
  private artifactsDir = '';
  /** Set by `arm`, cleared by `stop`; pages the attempt opens in between start segments. */
  private armed = false;
  private current: Segment | null = null;
  /** Segments finished this attempt, in order; `stop` hands them over. */
  private finished: VideoSegment[] = [];
  /** Segments started this attempt, for their file names. */
  private count = 0;

  constructor(viewport: { readonly width: number; readonly height: number }) {
    this.viewport = viewport;
  }

  /** Forgets the previous attempt's recording; this attempt's files land under `artifactsDir`. */
  reset(artifactsDir: string): void {
    this.artifactsDir = artifactsDir;
    this.armed = false;
    this.current = null;
    this.finished = [];
    this.count = 0;
  }

  /** True between `arm` and `stop`: a page the attempt opens then starts a segment. */
  get isArmed(): boolean {
    return this.armed;
  }

  /** True while a segment records, so a context closing early can end it within a budget. */
  get isRecording(): boolean {
    return this.current !== null;
  }

  /** Arms the recording and starts it on `page`, unless a segment already records. */
  async arm(page: Page): Promise<void> {
    this.armed = true;
    if (this.current === null) await this.begin(page);
  }

  /** A page the attempt opened: the next segment, when armed. */
  async pageOpened(page: Page): Promise<void> {
    if (this.armed) await this.begin(page);
  }

  /** The recorded page's context is closing: its segment ends here. */
  contextClosing(): Promise<void> {
    return this.end();
  }

  /** Ends the recording and returns every segment written this attempt, in order. */
  async stop(): Promise<readonly VideoSegment[]> {
    await this.end();
    this.armed = false;
    return this.finished.splice(0);
  }

  /** Runs a locator action with the pointer following it while recording; otherwise just the action. */
  follow(
    page: Page,
    target: ActionTarget,
    kind: LocatorAction['kind'],
    dispatch: () => Promise<void>,
  ): Promise<void> {
    return this.armed ? withCursorFollowing(page, target, kind, dispatch) : dispatch();
  }

  /** Runs a capture with the pointer hidden while recording, so evidence and model pixels never show it. */
  withoutCursor<T>(page: Page, work: () => Promise<T>): Promise<T> {
    return this.armed ? withCursorHidden(page, work) : work();
  }

  /**
   * Starts one segment on a page: the pointer overlay first, so it is in the
   * frames from the start, then the screencast at the attempt's viewport size.
   * A segment still recording (its page closed under the attempt) ends first.
   */
  private async begin(page: Page): Promise<void> {
    await this.end();
    await installCursorOverlay(page);
    this.count += 1;
    const name = this.count === 1 ? 'video' : `video-part${String(this.count)}`;
    const relative = path.posix.join('video', `${name}.webm`);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    await page.screencast.start({
      path: absolute,
      size: { width: this.viewport.width, height: this.viewport.height },
    });
    this.current = { page, relative, absolute, startedAt: new Date().toISOString() };
  }

  /**
   * Ends the segment in progress. A page that is already gone cannot be asked
   * to stop, but Playwright flushed its frames as it closed, so the file is
   * kept if it exists; a segment that wrote nothing is not a segment.
   */
  private async end(): Promise<void> {
    const segment = this.current;
    if (segment === null) return;
    this.current = null;
    await segment.page.screencast.stop().catch(() => undefined);
    if (existsSync(segment.absolute)) {
      this.finished.push({ path: segment.relative, startedAt: segment.startedAt });
    }
  }
}
