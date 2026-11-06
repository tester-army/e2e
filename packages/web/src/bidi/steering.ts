/** Navigation on the BiDi driver: open, history, reload, and the attempt's restart and reset. */

import { setTimeout as sleep } from 'node:timers/promises';
import { Deadline, EngineError } from 'e2e/engine';
import { isStale } from './errors.ts';
import { historyEntry } from './page.ts';
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
 * decides. Chromium rejects with `net::ERR_ABORTED` before announcing it,
 * and that error stands.
 */
async function navigateOrDownload(session: BidiSession, context: string, url: string, wait: 'complete' | 'interactive' | 'none', signal: AbortSignal): Promise<void> {
  let downloading = false;
  const off = session.connection.on('browsingContext.downloadWillBegin', (event) => {
    if (event.context === context) downloading = true;
  });
  try {
    await session.connection.send('browsingContext.navigate', { context, url, wait });
  } catch (cause) {
    if (!SUPERSEDED.test(cause instanceof Error ? cause.message : '')) throw cause;
    await documentReady(session, context, wait, signal);
  } finally {
    off();
  }
  if (downloading) throw new EngineError('ENGINE_FAILURE', `navigation to ${url} failed: Download is starting`, { retryable: false });
}

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
    const state = await session.read<string>('() => document.readyState', [], undefined, context).catch((cause: unknown) => {
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

/** Runs a navigation the driver makes itself, which the trace leaves to the step that asked for it. */
async function own<T>(session: BidiSession, work: () => Promise<T>): Promise<T> {
  session.ownNavigations += 1;
  try {
    return await work();
  } finally {
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

/** Closes the tab, keeping the user context's storage; the harness reopens the app. */
export function restart(session: BidiSession): Promise<void> {
  return session.closeContext();
}

/** Replaces the user context with a clean one and opens its blank tab. */
export async function reset(session: BidiSession): Promise<void> {
  await session.replaceUserContext();
  await session.ensureContext();
}
