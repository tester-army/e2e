/**
 * Downloads on the BiDi driver: the attempt's user context saves every
 * download into a directory of its own (`browser.setDownloadBehavior`), on
 * this machine or, for a provider that serves downloads, on the browser's,
 * and a wait pairs `browsingContext.downloadWillBegin` with `downloadEnd` by
 * the download's id.
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { raceAbort, TestError } from 'e2e/engine';
import type { LeaseDownloads } from '../provider.ts';
import type { BidiConnection } from './connection.ts';

/** One finished download: the name the server suggested and where the browser wrote it. */
export interface FinishedDownload {
  readonly suggestedFilename: string;
  readonly filepath: string;
}

/** One attempt's downloads: their directory, and waits for the downloads a trigger starts. */
export class AttemptDownloads {
  readonly dir: string;

  constructor(
    private readonly connection: BidiConnection,
    private readonly remote: LeaseDownloads | undefined,
  ) {
    this.dir = remote === undefined ? mkdtempSync(path.join(os.tmpdir(), 'e2e-bidi-downloads-')) : remote.dir;
  }

  /**
   * Copies one finished download to `file`: from this machine, or read off
   * the remote browser's disk through its provider, a read `signal` bounds:
   * one that does not finish fails the wait.
   */
  async save(download: FinishedDownload, file: string, signal: AbortSignal): Promise<void> {
    if (this.remote === undefined) {
      copyFileSync(download.filepath, file);
      return;
    }
    const bytes = await raceAbort(this.remote.read(download.filepath, signal), signal, 'download read').catch((cause: unknown) => {
      if (!signal.aborted) throw cause;
      throw new TestError('ACTION_FAILED', `download ${download.suggestedFilename} did not finish: ${this.remote!.provider} read it back too slowly`);
    });
    writeFileSync(file, bytes);
  }

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
    const startedAt = Date.now();
    let triggerMs: number | undefined;
    const triggered = trigger().then(() => {
      triggerMs = Date.now() - startedAt;
    });
    try {
      await raceAbort(Promise.all([triggered, done]), AbortSignal.any([signal, deadline]), 'download');
    } catch (cause) {
      if (deadline.aborted && !signal.aborted) {
        if (triggerMs === undefined) throw new TestError('ACTION_FAILED', `the download trigger did not resolve within ${timeoutMs}ms`);
        throw new TestError('ACTION_FAILED', started.length < count
          ? `${count === 1 ? 'no download' : `${started.length} of ${count} downloads`} started within ${timeoutMs}ms; the trigger resolved after ${triggerMs}ms`
          : `${count === 1 ? 'the download' : `${count} downloads`} did not finish within ${timeoutMs}ms`);
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

  /** Deletes the attempt's local download directory; files a wait saved are already copied out, and a remote one is the provider's. */
  dispose(): void {
    if (this.remote === undefined) rmSync(this.dir, { recursive: true, force: true });
  }
}
