/**
 * Downloads on the BiDi driver: the attempt's user context saves every
 * download into a directory of its own (`browser.setDownloadBehavior`), and a
 * wait pairs `browsingContext.downloadWillBegin` with `downloadEnd` by the
 * download's id.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { raceAbort, TestError } from 'e2e/engine';
import type { BidiConnection } from './connection.ts';

/** One finished download: the name the server suggested and where the browser wrote it. */
export interface FinishedDownload {
  readonly suggestedFilename: string;
  readonly filepath: string;
}

/** One attempt's downloads: their directory, and waits for the downloads a trigger starts. */
export class AttemptDownloads {
  readonly dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-bidi-downloads-'));

  constructor(private readonly connection: BidiConnection) {}

  /** Points the user context's downloads at this attempt's directory. */
  async allow(userContext: string): Promise<void> {
    await this.connection.send('browser.setDownloadBehavior', {
      downloadBehavior: { type: 'allowed', destinationFolder: this.dir },
      userContexts: [userContext],
    });
  }

  /**
   * Runs `trigger` and resolves with the first `count` downloads it starts,
   * in start order, once each has finished and the trigger returned. A
   * canceled one fails the wait. The wait owns its deadline: past
   * `timeoutMs`, or once `signal` aborts, it stops listening and fails,
   * whatever the trigger is still doing, and nothing it saw is kept.
   */
  async collect(count: number, trigger: () => Promise<void>, signal: AbortSignal, timeoutMs: number, ours: (context: string) => boolean): Promise<FinishedDownload[]> {
    const started: { readonly id: string; readonly suggestedFilename: string }[] = [];
    const ended = new Map<string, string | null>();
    let settled: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const check = (): void => {
      if (started.length === count && started.every((download) => ended.has(download.id))) settled();
    };
    const offBegin = this.connection.on('browsingContext.downloadWillBegin', (event) => {
      if (!ours(event.context) || started.length === count) return;
      started.push({ id: event.download, suggestedFilename: event.suggestedFilename });
      check();
    });
    const offEnd = this.connection.on('browsingContext.downloadEnd', (event) => {
      ended.set(event.download, event.status === 'complete' ? event.filepath : null);
      check();
    });
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      await raceAbort(Promise.all([trigger(), done]), AbortSignal.any([signal, deadline]), 'download');
    } catch (cause) {
      if (deadline.aborted && !signal.aborted) {
        throw new TestError('ACTION_FAILED', `${count === 1 ? 'no download' : `fewer than ${count} downloads`} finished within ${timeoutMs}ms`);
      }
      throw cause;
    } finally {
      offBegin();
      offEnd();
    }
    return started.map(({ id, suggestedFilename }) => {
      const filepath = ended.get(id);
      if (filepath == null) throw new TestError('ACTION_FAILED', `download ${suggestedFilename} was canceled`);
      return { suggestedFilename, filepath };
    });
  }

  /** Deletes the attempt's download directory; files a wait saved are already copied out. */
  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
