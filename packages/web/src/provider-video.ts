/**
 * The attempt's video as its browser provider records it: one recording of
 * the browser for the whole attempt, whichever pages open and close in it,
 * ended by `stopProviderRecording` into the attempt's one segment, a file in
 * its `video` directory or a link.
 */

import type { Page } from 'playwright-core';
import { stopProviderRecording, type VideoSegment } from 'e2e/engine';
import { connectionAbort } from './operation-budget.ts';
import type { LeaseRecording } from './provider.ts';
import type { AttemptVideo } from './video.ts';

/** How long a recording that started after its attempt gave up gets to stop. */
const LATE_STOP_MS = 10_000;

export class ProviderVideo implements AttemptVideo {
  /** The recording covers the browser, so no page starts a segment of its own. */
  readonly isArmed = false;
  /** The provider records the browser from outside; the page's screencast stays the trace's. */
  readonly startsScreencast = false;
  private started: LeaseRecording | undefined;
  /** The stop in flight, shared: a close that retries while a timed-out stop is still running waits for it instead of stopping twice. */
  private stopping: Promise<readonly VideoSegment[]> | undefined;

  constructor(
    private readonly record: (signal: AbortSignal) => Promise<LeaseRecording>,
    private readonly artifactsDir: string,
  ) {}

  /**
   * Starts the provider's recording. One that arrives once `signal` aborted
   * (a start that outlived its budget) is stopped at once and never kept, and
   * never replaces the handle of a recording started after it.
   */
  async arm(_page: Page, signal: AbortSignal): Promise<void> {
    const started = await this.record(signal);
    if (!signal.aborted) {
      this.started = started;
      return;
    }
    await this.stopLease(started, AbortSignal.timeout(LATE_STOP_MS)).catch(() => undefined);
    throw connectionAbort(signal, 'video');
  }

  /** Pages come and go under one recording of the browser. */
  async pageOpened(): Promise<void> {}

  /** Pages come and go under one recording of the browser. */
  async pageClosing(): Promise<void> {}

  /**
   * Stops the recording as the attempt's one segment; nothing when none was
   * started. A stop that failed keeps the recording, so the attempt's close
   * tries once more instead of leaving it running on a browser later
   * attempts share.
   */
  stop(signal: AbortSignal): Promise<readonly VideoSegment[]> {
    const started = this.started;
    if (started === undefined) return Promise.resolve([]);
    this.stopping ??= this.stopLease(started, signal).then(
      (segment) => {
        if (this.started === started) this.started = undefined;
        return [segment];
      },
    ).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /**
   * Stops a recording the attempt never collected, best effort: the attempt
   * keeps nothing of it. A stop that fails keeps the handle, so the recording
   * is never marked stopped while it may still run.
   */
  async abandon(signal: AbortSignal): Promise<void> {
    await this.stop(signal).catch(() => undefined);
  }

  /** Ends one of the provider's recordings as a segment of the attempt. */
  private stopLease(started: LeaseRecording, signal: AbortSignal): Promise<VideoSegment> {
    return stopProviderRecording(started.recording, {
      artifactsDir: this.artifactsDir,
      provider: started.provider,
      leaseId: started.leaseId,
      signal,
    });
  }
}
