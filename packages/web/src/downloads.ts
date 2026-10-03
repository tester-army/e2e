/**
 * Downloads from a browser on another machine. Playwright asks a CDP-attached
 * browser to save each file under a directory of the runner's, which a
 * remote browser does not have, so the download is canceled. A provider
 * that serves downloads names a directory on the browser's own disk; the
 * browser saves there, and the provider reads each finished file back.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, CDPSession, Download, Page } from 'playwright-core';
import { EngineError } from 'e2e/engine';
import type { LeaseDownloads } from './provider.ts';
import { invalidState, message } from './support.ts';

/** One browser-level CDP session per connection: a download behavior lives as long as the session that set it. */
const browserSessions = new WeakMap<Browser, Promise<CDPSession>>();

/**
 * Has the browser behind `page` save the downloads of the page's context
 * under `dir` on its own disk, each file named by its download id, with the
 * download events Playwright's waiter reads left on.
 */
export async function saveDownloadsTo(page: Page, dir: string): Promise<void> {
  const context = page.context();
  const browser = context.browser();
  if (browser === null) throw invalidState('the page has no browser to set a download directory on');
  const pageSession = await context.newCDPSession(page);
  let browserContextId: string | undefined;
  try {
    ({ targetInfo: { browserContextId } } = await pageSession.send('Target.getTargetInfo'));
  } finally {
    await pageSession.detach().catch(() => undefined);
  }
  let session = browserSessions.get(browser);
  if (session === undefined) {
    session = browser.newBrowserCDPSession();
    browserSessions.set(browser, session);
    session.catch(() => browserSessions.delete(browser));
  }
  await (await session).send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: dir,
    eventsEnabled: true,
    ...(browserContextId === undefined ? {} : { browserContextId }),
  });
}

/**
 * Copies a finished download off the browser's disk to `file` through the
 * provider: it lies under `dir`, named by its download id, as
 * `saveDownloadsTo` had the browser name it. A download that failed or was
 * canceled fails with the browser's reason.
 */
export async function saveFromBrowser(download: Download, downloads: LeaseDownloads, file: string, signal: AbortSignal): Promise<void> {
  const failure = await download.failure();
  if (failure !== null) throw new EngineError('ENGINE_FAILURE', `download failed: ${failure}`, { retryable: false });
  // Playwright names its own record of the file by the same download id.
  const saved = path.posix.join(downloads.dir, path.basename(await download.path()));
  await writeFile(file, await downloads.read(saved, signal));
}

/**
 * Saves a download Playwright received for the runner to `file`. When the
 * file may have stayed on another machine, `unserved` says why, and a failed
 * save names it.
 */
export async function saveLocally(download: Download, file: string, unserved: string | undefined): Promise<void> {
  try {
    await download.saveAs(file);
  } catch (cause) {
    if (unserved === undefined) throw cause;
    throw new EngineError('ENGINE_FAILURE', `download failed: ${message(cause)}; ${unserved}`, { retryable: false, cause });
  }
}
