/** The slice of the Notte SDK the provider uses, loaded on first use so a config load never pays for it. */

import type { ApiSessionStartRequest } from 'notte-sdk';

/**
 * Notte's start-session body, less the fields a browser provider cannot
 * serve: `cdp_url` (a browser from another provider) and managed
 * authentication (`auth_ids`, `auth_retry`, `wait_for_authentication`),
 * which returns the session before it can be attached to.
 */
export type NotteSessionParams = Omit<ApiSessionStartRequest, 'cdp_url' | 'auth_ids' | 'auth_retry' | 'wait_for_authentication'>;

interface NotteSession {
  readonly sessionId: string;
  readonly cdpUrl: string;
}

export interface NotteSessions {
  /**
   * Starts a session. The request is never aborted: a cancelled request would
   * leave a session Notte started that nobody knows the id of, so the caller
   * waits for it and stops it instead.
   */
  start(params: NotteSessionParams): Promise<NotteSession>;
  /** Stops the session; one Notte already closed counts as stopped. Resolves to whether Notte still had it open. */
  stop(sessionId: string, signal: AbortSignal): Promise<boolean>;
}

/** Whether a failed stop says the session had already ended, the way the SDK's own `Session.stop` reads it. */
function alreadyClosed(cause: unknown, statusCode: number | undefined): boolean {
  if (statusCode === 404) return true;
  const text = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
  return text.includes('already stopped') || text.includes('already closed');
}

/** Notte sessions for one API key and API URL, through the SDK. */
export function notteSessions(apiKey: string, baseUrl: string | undefined): NotteSessions {
  const sdk = import('notte-sdk').then((module) => ({
    client: new module.NotteClient({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) }),
    NotteAPIError: module.NotteAPIError,
  }));
  return {
    async start(params) {
      const { client } = await sdk;
      const session = await client.sessions.start(params);
      if (typeof session.cdp_url !== 'string' || session.cdp_url === '') {
        throw new Error(`session ${session.session_id} started without a CDP URL`);
      }
      return { sessionId: session.session_id, cdpUrl: session.cdp_url };
    },
    async stop(sessionId, signal) {
      const { client, NotteAPIError } = await sdk;
      try {
        const session = await client.sessions.stop(sessionId, undefined, { signal });
        if (session.status !== 'closed') throw new Error(`session ${sessionId} is still ${session.status} after stop`);
        return true;
      } catch (cause) {
        if (alreadyClosed(cause, cause instanceof NotteAPIError ? cause.statusCode : undefined)) return false;
        throw cause;
      }
    },
  };
}
