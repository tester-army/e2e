/** Notte's cloud browsers as a `BrowserProvider` for the web engine. */

import type { BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { envValue } from './env.ts';
import { notteSessions, type NotteSessionParams, type NotteSessions } from './client.ts';

const NOTTE_API_KEY = 'NOTTE_API_KEY';
const NOTTE_API_URL = 'NOTTE_API_URL';

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
 * per-worker browser needs to keep tests apart. Notte ends a session a dead
 * worker never released after `idle_timeout_minutes`.
 * `NOTTE_API_KEY` comes from the run's environment, and `NOTTE_API_URL`
 * when set.
 */
export function notte(options: NotteOptions = {}): BrowserProvider {
  const params = { ...options };
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
      if (request.signal.aborted) {
        const outcome = await client.stop(session.sessionId, AbortSignal.timeout(10_000)).then(
          () => 'stopped',
          (cause: unknown) => `stopping it failed, so Notte ends it after idle_timeout_minutes: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        throw new Error(`session ${session.sessionId} arrived after the request was cancelled; ${outcome}`);
      }
      // Only the id: Notte's viewer URL carries tokens that act on the session, and a run's log is often public CI output.
      request.log(`session ${session.sessionId}`);
      return { id: session.sessionId, cdpEndpoint: session.cdpUrl };
    },
    async release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void> {
      await clientFor(context.env).stop(lease.id, context.signal);
    },
  };
}
