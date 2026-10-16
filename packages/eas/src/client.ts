/**
 * EAS Simulators' sessions through Expo's GraphQL API over `fetch`, the API
 * `eas simulator:*` uses, so the integration installs no SDK.
 */

import type { ExpoCredentials } from './credentials.ts';
import { isRecord } from './json.ts';

const GRAPHQL_URL = 'https://api.expo.dev/graphql';

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

const CREATE = `mutation ($input: CreateDeviceRunSessionInput!) {
  deviceRunSession { createDeviceRunSession(deviceRunSessionInput: $input) { id app { slug ownerAccount { name } } } }
}`;

const STATE = `query ($id: ID!) {
  deviceRunSessions { byId(deviceRunSessionId: $id) {
    status
    turtleJobRun { status }
    remoteConfig { ... on AgentDeviceRunSessionRemoteConfig { agentDeviceRemoteSessionUrl agentDeviceRemoteSessionToken webPreviewUrl webPreviewToken } }
  } }
}`;

const STOP = `mutation ($id: ID!) {
  deviceRunSession { ensureDeviceRunSessionStopped(deviceRunSessionId: $id) { turtleJobRun { id status } } }
}`;

const CANCEL_JOB = `mutation ($id: ID!) {
  jobRun { cancelJobRun(jobRunId: $id) { id } }
}`;

/** Job run states before the job picks the session up: waiting for the account's concurrency. */
const QUEUED_JOB = new Set(['NEW', 'IN_QUEUE']);
/** Job run states after which the session never becomes ready. */
const ENDED_JOB = new Set(['ERRORED', 'CANCELED', 'FINISHED', 'PENDING_CANCEL']);

/** EAS Simulators sessions for one Expo access token or eas-cli session. */
export function easSessions(credentials: ExpoCredentials): EasSessions {
  const auth: Record<string, string> =
    'accessToken' in credentials ? { Authorization: `Bearer ${credentials.accessToken}` } : { 'expo-session': credentials.sessionSecret };
  /** Runs one operation and returns its unchecked `data`; a GraphQL error throws with EAS's message and error code. */
  const graphql = async (query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`EAS: HTTP ${response.status}, ${text.trim().slice(0, 200)}`);
    }
    const errors = field(body, 'errors');
    const error: unknown = Array.isArray(errors) ? errors[0] : undefined;
    if (error !== undefined) {
      const message = field(error, 'message');
      const code = field(field(error, 'extensions'), 'errorCode');
      throw new EasError(typeof message === 'string' ? message : `HTTP ${response.status}`, typeof code === 'string' ? code : undefined);
    }
    const data = field(body, 'data');
    if (!response.ok || data == null) throw new Error(`EAS: HTTP ${response.status}, no data`);
    return data;
  };
  return {
    async create({ platform, deviceIdentifier, ...fields }, signal) {
      const input = {
        ...fields,
        platform: platform.toUpperCase(),
        type: 'AGENT_DEVICE',
        ...(deviceIdentifier === undefined ? {} : { [platform]: { deviceIdentifier } }),
      };
      const created = field(field(await graphql(CREATE, { input }, signal), 'deviceRunSession'), 'createDeviceRunSession');
      const id = field(created, 'id');
      const app = field(created, 'app');
      const slug = field(app, 'slug');
      const owner = field(field(app, 'ownerAccount'), 'name');
      if (typeof id !== 'string' || typeof slug !== 'string' || typeof owner !== 'string') throw unexpected('createDeviceRunSession');
      return { id, url: `https://expo.dev/accounts/${encodeURIComponent(owner)}/projects/${encodeURIComponent(slug)}/simulator-sessions/${id}` };
    },
    async state(id, signal) {
      const session = field(field(await graphql(STATE, { id }, signal), 'deviceRunSessions'), 'byId');
      const status = field(session, 'status');
      const jobRun = field(session, 'turtleJobRun');
      const job = field(jobRun, 'status');
      const config = field(session, 'remoteConfig');
      const daemonUrl = field(config, 'agentDeviceRemoteSessionUrl');
      const daemonToken = field(config, 'agentDeviceRemoteSessionToken');
      const previewUrl = field(config, 'webPreviewUrl');
      const previewToken = field(config, 'webPreviewToken');
      if (
        typeof status !== 'string' ||
        (jobRun != null && typeof job !== 'string') ||
        (config != null && !isRecord(config)) ||
        ![daemonUrl, daemonToken, previewUrl, previewToken].every((value) => value == null || typeof value === 'string')
      ) {
        throw unexpected('deviceRunSessions.byId');
      }
      if (status === 'STOPPED' || status === 'ERRORED') return { phase: 'ended', status: status.toLowerCase() };
      // A job that ended keeps the daemon address it had, which no longer answers.
      if (typeof job === 'string' && ENDED_JOB.has(job)) return { phase: 'ended', status: `job ${job.toLowerCase()}` };
      if (typeof daemonUrl === 'string' && typeof daemonToken === 'string') {
        const openPreviewUrl = previewToken == null && typeof previewUrl === 'string' ? previewUrl : undefined;
        return { phase: 'ready', daemonUrl, daemonToken, openPreviewUrl };
      }
      return { phase: typeof job !== 'string' || QUEUED_JOB.has(job) ? 'queued' : 'starting' };
    },
    async stop(id, signal) {
      let data: unknown;
      try {
        data = await graphql(STOP, { id }, signal);
      } catch (cause) {
        if (cause instanceof EasError && cause.code === 'NOT_FOUND_ERROR') return;
        throw cause;
      }
      const stopped = field(field(data, 'deviceRunSession'), 'ensureDeviceRunSessionStopped');
      if (!isRecord(stopped)) throw unexpected('ensureDeviceRunSessionStopped');
      const job = stopped['turtleJobRun'];
      if (job === null) return;
      const jobId = field(job, 'id');
      const jobStatus = field(job, 'status');
      if (typeof jobId !== 'string' || typeof jobStatus !== 'string') throw unexpected('ensureDeviceRunSessionStopped');
      if (QUEUED_JOB.has(jobStatus)) await graphql(CANCEL_JOB, { id: jobId }, signal);
    },
  };
}

/** `key` of a JSON object; `undefined` for a missing key or a value that is not an object. */
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** The error for an answer without the fields an operation reads; it names no value, since the answer can hold a daemon token. */
function unexpected(operation: string): Error {
  return new Error(`EAS: unexpected response to ${operation}`);
}

/** An error EAS answered with, its `errorCode` kept. */
class EasError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(`EAS: ${message}`);
  }
}
