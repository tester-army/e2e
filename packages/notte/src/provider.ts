/** Notte's cloud browsers as a `BrowserProvider` for the web engine. */

import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserDownloadContext, BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { envValue } from './env.ts';
import { clear, forget, remember, remembered } from './ledger.ts';
import { notteSessions, type NotteSessionParams, type NotteSessions } from './client.ts';

const NOTTE_API_KEY = 'NOTTE_API_KEY';
const NOTTE_API_URL = 'NOTTE_API_URL';

/**
 * Where the engine asks the browser to save downloads. Notte saves every
 * download of a session under `/tmp/session-downloads/<session id>` whatever
 * path a client names, and collects it into the session's file storage.
 */
const DOWNLOADS_DIR = '/tmp/session-downloads';

/** How often `downloads.read` asks Notte again for a download it has not collected yet. */
const DOWNLOAD_POLL_MS = 500;

/**
 * How long `downloads.read` waits for a file named as the site suggested
 * before it takes the session's one unread file under another name: Notte
 * may store a name the browser would not.
 */
const DOWNLOAD_NAME_GRACE_MS = 5_000;

/** The Notte console page of one session, which needs a console sign-in rather than a token. */
const consoleUrl = (sessionId: string): string => `https://console.notte.cc/sessions/${sessionId}`;

/**
 * Notte's start-session body as it is: `solve_captchas`, `proxies`,
 * `browser_type`, `idle_timeout_minutes`, `max_duration_minutes`,
 * `viewport_width`, `viewport_height`, `profile`, `user_agent`, ...
 */
export type NotteOptions = NotteSessionParams;

/**
 * Notte cloud browsers for `web({ browser: notte() })`: a fresh session per
 * test attempt, started when the attempt starts and stopped when it ends.
 * The scope is always `attempt`: a Notte session owns its one browser
 * context and refuses `Target.createBrowserContext`, which a shared
 * per-worker browser needs to keep tests apart. When the run ends, `sweep`
 * stops the sessions of workers that died before they could, and Notte ends
 * any session the run itself left after `idle_timeout_minutes`.
 * `NOTTE_API_KEY` comes from the run's environment, and `NOTTE_API_URL`
 * when set.
 */
export function notte(options: NotteOptions = {}): BrowserProvider {
  const params = { ...options };
  /** The storage file ids each session's downloads were already read from, so each finished download is read once. */
  const claimed = new Map<string, Set<string>>();
  /**
   * The bytes of one download of the lease's session, read once. Notte stores
   * a download under the name the site suggested, not the download id the
   * engine knows, so the file is found by `context.suggestedFilename`: the
   * oldest unread file of that name. Without a name (an engine older than
   * that field), or with none of that name after a grace period while the
   * session holds exactly one unread file, it takes the oldest unread file.
   */
  const readDownload = async (lease: BrowserLease, file: string, context: BrowserDownloadContext): Promise<Uint8Array> => {
    const client = clientFor(context.env);
    let seen = claimed.get(lease.id);
    if (seen === undefined) {
      seen = new Set();
      claimed.set(lease.id, seen);
    }
    const name = context.suggestedFilename;
    const started = Date.now();
    for (;;) {
      const unread = (await client.downloads(lease.id, context.signal)).filter((download) => !seen.has(download.id));
      const next =
        name === undefined
          ? unread[0]
          : (unread.find((download) => download.filename === name) ??
            (unread.length === 1 && Date.now() - started >= DOWNLOAD_NAME_GRACE_MS ? unread[0] : undefined));
      if (next !== undefined) {
        seen.add(next.id);
        return client.readFile(lease.id, next.id, context.signal);
      }
      await sleep(DOWNLOAD_POLL_MS, undefined, { signal: context.signal }).catch(() => {
        throw new Error(`download ${file} never reached session ${lease.id}'s file storage`);
      });
    }
  };
  const clients = new Map<string, NotteSessions>();
  const clientFor = (env: BrowserRequest['env']): NotteSessions => {
    const apiKey = envValue(env, NOTTE_API_KEY);
    if (apiKey === undefined) throw new Error(`${NOTTE_API_KEY} is not set`);
    const baseUrl = envValue(env, NOTTE_API_URL);
    const key = `${baseUrl ?? ''}\n${apiKey}`;
    let client = clients.get(key);
    if (client === undefined) {
      client = notteSessions(apiKey, baseUrl);
      clients.set(key, client);
    }
    return client;
  };
  return {
    name: 'notte',
    scope: 'attempt',
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const client = clientFor(request.env);
      request.signal.throwIfAborted();
      const session = await client.start(params);
      await remember(request.runId, request.targetName, session.sessionId);
      const { cdpUrl } = session;
      if (cdpUrl === undefined || request.signal.aborted) {
        const why = cdpUrl === undefined ? 'started without a CDP URL' : 'arrived after the request was cancelled';
        const outcome = await client.stop(session.sessionId, AbortSignal.timeout(10_000)).then(
          async () => {
            await forget(request.runId, request.targetName, session.sessionId);
            return 'stopped';
          },
          (cause: unknown) => `stopping it failed, so the run's sweep or Notte's idle_timeout_minutes ends it: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        throw new Error(`session ${session.sessionId} ${why}; ${outcome}`);
      }
      // Never the viewer URL: it carries tokens that act on the session, and a run's log is often public CI output.
      request.log(envValue(request.env, NOTTE_API_URL) === undefined ? `session ${session.sessionId}, watch at ${consoleUrl(session.sessionId)}` : `session ${session.sessionId}`);
      return { id: session.sessionId, cdpEndpoint: cdpUrl };
    },
    async release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
      claimed.delete(lease.id);
      await clientFor(context.env).stop(lease.id, context.signal);
      await forget(context.runId, context.targetName, lease.id);
    },
    async sweep(context: BrowserReleaseContext): Promise<readonly string[]> {
      const open = await remembered(context.runId, context.targetName);
      if (open.length === 0) {
        await clear(context.runId, context.targetName);
        return [];
      }
      const client = clientFor(context.env);
      const settled = await Promise.allSettled(open.map(async (id) => ((await client.stop(id, context.signal)) ? id : undefined)));
      const stopped = settled.flatMap((result) => (result.status === 'fulfilled' && result.value !== undefined ? [result.value] : []));
      const failed = open.flatMap((id, index) => {
        const result = settled[index]!;
        return result.status === 'rejected' ? [`${id} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`] : [];
      });
      await clear(context.runId, context.targetName);
      if (failed.length > 0) {
        throw new Error(`stopped ${stopped.length === 0 ? 'none' : stopped.join(', ')}; could not stop ${failed.join(', ')}, so Notte ends it after idle_timeout_minutes`);
      }
      return stopped;
    },
    downloads: { dir: DOWNLOADS_DIR, read: readDownload },
  };
}
