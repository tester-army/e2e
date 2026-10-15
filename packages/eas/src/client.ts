/**
 * EAS Simulators' sessions through Expo's REST API over `fetch`, so the
 * integration installs no SDK.
 */

import { createRequire } from 'node:module';
import type { ExpoCredentials } from './credentials.ts';

const SESSIONS_URL = 'https://api.expo.dev/v2/device-run-sessions';

/** This package as `name@version`, the format EAS records a session's client in. */
const CLIENT = `@e2e-dev/eas@${ownVersion()}`;

/** What the provider asks EAS for: one agent-device session on one platform. */
export interface EasSessionParams {
  readonly appId: string;
  readonly platform: 'ios' | 'android';
  readonly name: string;
  readonly tags: readonly string[];
  readonly buildId?: string | undefined;
  readonly applicationArchiveUrl?: string | undefined;
  /** An iOS device name or UDID, or an Android AVD hardware profile. */
  readonly deviceIdentifier?: string | undefined;
  readonly maxIdleTimeMinutes?: number | undefined;
  readonly maxRunTimeMinutes?: number | undefined;
  /** The agent-device version EAS starts the daemon at. */
  readonly packageVersion?: string | undefined;
}

/** Where a session is: `queued` until the account has a free simulator, `starting` while it boots, `ready` once its daemon is reachable. */
export type EasSessionState =
  | { readonly phase: 'queued' | 'starting' }
  | {
      readonly phase: 'ready';
      readonly daemonUrl: string;
      readonly daemonToken: string;
      /** The browser preview, when it opens without a token; a gated one is left out so its token stays out of logs. */
      readonly openPreviewUrl: string | undefined;
    }
  | { readonly phase: 'ended'; readonly status: string };

export interface EasCreatedSession {
  readonly id: string;
  /** The session's page on expo.dev. */
  readonly url: string;
}

export interface EasSessions {
  create(params: EasSessionParams, signal: AbortSignal): Promise<EasCreatedSession>;
  state(id: string, signal: AbortSignal): Promise<EasSessionState>;
  /**
   * Stops the session, and cancels its job when it is still queued: a stopped
   * session's queued job still starts later and holds one of the account's
   * concurrent sessions while it does. Stopping one already stopped, or one
   * EAS no longer knows, succeeds.
   */
  stop(id: string, signal: AbortSignal): Promise<void>;
}

interface RestError {
  readonly code?: string;
  readonly message?: string;
}

interface RestSession {
  readonly id: string;
  /** The session's page on expo.dev. */
  readonly url: string;
  readonly status: 'new' | 'queued' | 'starting' | 'in-progress' | 'stopped' | 'errored';
  readonly remoteConfig: {
    readonly agentDeviceRemoteSessionUrl?: string;
    readonly agentDeviceRemoteSessionToken?: string;
    readonly webPreviewUrl?: string | null;
    readonly webPreviewToken?: string | null;
  } | null;
}

/** EAS Simulators sessions for one Expo access token or eas-cli session. */
export function easSessions(credentials: ExpoCredentials): EasSessions {
  const auth: Record<string, string> =
    'accessToken' in credentials ? { Authorization: `Bearer ${credentials.accessToken}` } : { 'expo-session': credentials.sessionSecret };
  /** Sends one request; an error EAS answers with throws with its message and error code. */
  const rest = async <T>(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<T> => {
    const response = await fetch(`${SESSIONS_URL}${path}`, {
      method,
      headers: body === undefined ? auth : { ...auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const text = await response.text();
    let parsed: { data?: T | null; errors?: readonly RestError[] };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`EAS: HTTP ${response.status}, ${text.trim().slice(0, 200)}`);
    }
    const error = parsed.errors?.[0];
    if (error !== undefined) throw new EasError(error.message ?? `HTTP ${response.status}`, error.code);
    if (!response.ok || parsed.data == null) throw new Error(`EAS: HTTP ${response.status}, no data`);
    return parsed.data;
  };
  const sessionPath = (id: string): string => `/${encodeURIComponent(id)}`;
  return {
    async create({ maxRunTimeMinutes, ...fields }, signal) {
      const body = { ...fields, maxDurationMinutes: maxRunTimeMinutes, type: 'agent-device', client: CLIENT };
      const { id, url } = await rest<RestSession>('POST', '', body, signal);
      return { id, url };
    },
    async state(id, signal) {
      const session = await rest<RestSession>('GET', sessionPath(id), undefined, signal);
      const config = session.remoteConfig;
      // EAS ends the session when its job ends; an ended session keeps a daemon address that no longer answers.
      if (session.status === 'stopped' || session.status === 'errored') return { phase: 'ended', status: session.status };
      if (config?.agentDeviceRemoteSessionUrl !== undefined && config.agentDeviceRemoteSessionToken !== undefined) {
        const openPreviewUrl = config.webPreviewToken == null ? (config.webPreviewUrl ?? undefined) : undefined;
        return { phase: 'ready', daemonUrl: config.agentDeviceRemoteSessionUrl, daemonToken: config.agentDeviceRemoteSessionToken, openPreviewUrl };
      }
      // `new` until the job enters the queue, `queued` while it waits for the account's concurrency.
      return { phase: session.status === 'new' || session.status === 'queued' ? 'queued' : 'starting' };
    },
    async stop(id, signal) {
      // EAS cancels the session's job too when it is still queued.
      try {
        await rest('POST', `${sessionPath(id)}/stop`, undefined, signal);
      } catch (cause) {
        if (cause instanceof EasError && cause.code === 'NOT_FOUND_ERROR') return;
        throw cause;
      }
    },
  };
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** An error EAS answered with, its error code kept. */
class EasError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(`EAS: ${message}`);
  }
}
