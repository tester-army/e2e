/** Navigation on the BiDi driver: open, history, reload, and the attempt's restart and reset. */

import { setTimeout as sleep } from 'node:timers/promises';
import { Deadline, EngineError, raceAbort, TestError } from 'e2e/engine';
import { isClassified, message } from '../support.ts';
import { isStale } from './errors.ts';
import { historyEntry, readyState } from './page.ts';
import type { BidiSession } from './session.ts';

/** How a navigation waits: the `waitUntil` the `browser` fixture takes. */
export type WaitUntil = 'load' | 'domcontentloaded' | 'commit' | 'networkidle';

/** Pause between reads of a history navigation that has not landed yet. */
const POLL_MS = 50;

/**
 * Navigates the attempt's tab to `url`, creating it on first use. A
 * `networkidle` wait then holds until no request has been in flight for
 * 500 ms, counted from before the navigation started. No navigation is sent
 * once `signal` aborted, nor in `reload` and `traverse`.
 */
export function goto(session: BidiSession, url: string, waitUntil: WaitUntil, signal: AbortSignal): Promise<void> {
  return own(session, async () => {
    const context = await session.ensureContext();
    await session.visit(url);
    if (waitUntil === 'networkidle') await session.network.track();
    const wait = waitUntil === 'load' || waitUntil === 'networkidle' ? 'complete' : waitUntil === 'domcontentloaded' ? 'interactive' : 'none';
    signal.throwIfAborted();
    await navigateOrDownload(session, context, url, wait, signal);
    if (waitUntil === 'networkidle') await session.network.waitForIdle(signal);
  });
}

/**
 * Sends one navigation and fails it as Playwright's `goto` does when the
 * response turns into a download. Firefox announces the download before
 * the navigation settles on the old document, so its start in this tab
 * decides. Chromium hands the response to its download manager and rejects
 * the navigation with `net::ERR_ABORTED` first, announcing the download for
 * that navigation (`browsingContext.downloadWillBegin` with its id) right
 * after; so an abort of a navigation that got a response a download can come
 * from waits for that announcement, up to `DOWNLOAD_HANDOFF_MS`, and an
 * abort that gets none stands.
 */
async function navigateOrDownload(session: BidiSession, context: string, url: string, wait: 'complete' | 'interactive' | 'none', signal: AbortSignal): Promise<void> {
  const connection = session.connection;
  const target = URL.canParse(url) ? new URL(url).href : url;
  let navigation: string | undefined;
  let responded = false;
  let downloading = false;
  let announced: () => void = () => undefined;
  const announcement = new Promise<void>((resolve) => (announced = resolve));
  const offs = [
    connection.on('browsingContext.navigationStarted', (event) => {
      if (event.context === context && navigation === undefined && event.url === target) navigation = event.navigation ?? undefined;
    }),
    connection.on('network.responseStarted', (event) => {
      if (navigation !== undefined && event.navigation === navigation && !NO_CONTENT.has(event.response.status)) responded = true;
    }),
    connection.on('browsingContext.downloadWillBegin', (event) => {
      if (event.context !== context || (navigation !== undefined && event.navigation != null && event.navigation !== navigation)) return;
      downloading = true;
      announced();
    }),
  ];
  try {
    await connection.send('browsingContext.navigate', { context, url, wait });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : '';
    if (ABORTED.test(reason) && responded) await downloadAnnounced(announcement, signal);
    if (downloading) throw new EngineError('ENGINE_FAILURE', `navigation to ${url} failed: Download is starting`, { retryable: false });
    if (!SUPERSEDED.test(reason)) throw cause;
    await documentReady(session, context, wait, signal);
  } finally {
    for (const off of offs) off();
  }
  if (downloading) throw new EngineError('ENGINE_FAILURE', `navigation to ${url} failed: Download is starting`, { retryable: false });
}

/**
 * How long an aborted navigation's download announcement may trail the
 * abort. Both come from one browser-side handoff of the response to the
 * download manager, so the announcement trails by a hop between browser
 * threads (the same millisecond on an idle machine), not by network or page
 * work; a second leaves a loaded machine ample room.
 */
const DOWNLOAD_HANDOFF_MS = 1_000;

/** Waits for `announcement` up to `DOWNLOAD_HANDOFF_MS`; only `signal` aborting fails the wait. */
async function downloadAnnounced(announcement: Promise<void>, signal: AbortSignal): Promise<void> {
  const window = AbortSignal.timeout(DOWNLOAD_HANDOFF_MS);
  await raceAbort(announcement, AbortSignal.any([signal, window]), 'download announcement').catch((cause: unknown) => {
    if (signal.aborted || !window.aborted) throw cause;
  });
}

/** Chromium's answer to a navigation it stopped, which a response handed to the download manager also gets. */
const ABORTED = /net::ERR_ABORTED/;

/** The statuses whose response Chromium neither shows nor downloads, aborting the navigation. */
const NO_CONTENT: ReadonlySet<number> = new Set([204, 205]);

/** Chromium's answer to a navigation another one replaced, as a page script redirecting the tab does mid-load. */
const SUPERSEDED = /navigation canceled by concurrent navigation/i;

/**
 * Waits until the tab's current document reaches `wait`: the navigation that
 * replaced ours (a client redirect), which Playwright's `goto` follows as
 * the one it waits for. A document still being replaced reads again.
 */
async function documentReady(session: BidiSession, context: string, wait: 'complete' | 'interactive' | 'none', signal: AbortSignal): Promise<void> {
  if (wait === 'none') return;
  for (;;) {
    signal.throwIfAborted();
    const state = await session.run(readyState, [], context).catch((cause: unknown) => {
      if (isStale(cause)) return 'loading';
      throw cause;
    });
    if (state === 'complete' || (wait === 'interactive' && state === 'interactive')) return;
    await sleep(POLL_MS, undefined, { signal });
  }
}

/** Reloads the tab and waits for its load event. */
export function reload(session: BidiSession, signal: AbortSignal): Promise<void> {
  return own(session, async () => {
    signal.throwIfAborted();
    await session.connection.send('browsingContext.reload', { context: session.requireContext(), wait: 'complete' });
  });
}

/**
 * Moves `delta` entries through the tab's history and waits until the
 * document reads complete on another entry than before: a new document, a
 * page restored from the back-forward cache, or the same document on an
 * entry the app pushed, whose URL may not differ.
 */
export function traverse(session: BidiSession, delta: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return own(session, async () => {
    const context = session.requireContext();
    const deadline = new Deadline(timeoutMs);
    const before = await landedEntry(session);
    signal.throwIfAborted();
    await session.connection.send('browsingContext.traverseHistory', { context, delta });
    for (;;) {
      const entry = await landedEntry(session);
      if (entry !== undefined && entry !== before) return;
      if (deadline.expired()) throw new EngineError('OPERATION_TIMEOUT', 'history navigation did not load in time', { retryable: false });
      await sleep(POLL_MS, undefined, { signal });
    }
  });
}

/**
 * Runs a navigation the driver makes itself, which the trace leaves to the
 * step that asked for it. A navigation that fails after a test route aborted
 * the tab's document request failed because the test aborted it: an action
 * failure, not an engine fault.
 */
async function own<T>(session: BidiSession, work: () => Promise<T>): Promise<T> {
  session.ownNavigations += 1;
  const watch: { url?: string } = {};
  session.navigationAborts.add(watch);
  try {
    return await work();
  } catch (cause) {
    if (watch.url === undefined || isClassified(cause)) throw cause;
    throw new TestError('ACTION_FAILED', `navigation failed: a route aborted the request for ${watch.url}: ${message(cause)}`, { cause });
  } finally {
    session.navigationAborts.delete(watch);
    session.ownNavigations -= 1;
  }
}

/** The tab's history entry once its document reads complete; undefined while it loads or is being replaced. */
async function landedEntry(session: BidiSession): Promise<string | undefined> {
  try {
    return (await session.run(historyEntry, [])) ?? undefined;
  } catch (cause) {
    if (isStale(cause)) return undefined;
    throw cause;
  }
}

/**
 * Closes every tab, keeping the user context's storage, and opens a blank
 * one; the harness reopens the app. Stops once `signal` aborts, so a restart
 * given up on never opens a tab under the step after it.
 */
export async function restart(session: BidiSession, signal: AbortSignal): Promise<void> {
  await session.closeContext(signal);
  signal.throwIfAborted();
  await session.ensureContext();
}

/**
 * Replaces the user context with a clean one and opens its blank tab. Stops
 * once `signal` aborts: a replacement that lands after removes itself.
 */
export async function reset(session: BidiSession, signal: AbortSignal): Promise<void> {
  await session.replaceUserContext(signal);
  signal.throwIfAborted();
  await session.ensureContext();
}
