/**
 * EAS Simulators' sessions through Expo's GraphQL API over `fetch`, the API
 * `eas simulator:*` uses, so the integration installs no SDK.
 */

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

interface GraphqlError {
  readonly message?: string;
  readonly extensions?: { readonly errorCode?: string };
}

interface SessionById {
  readonly status: 'NEW' | 'IN_PROGRESS' | 'STOPPED' | 'ERRORED';
  readonly turtleJobRun: { readonly status: string } | null;
  readonly remoteConfig: {
    readonly agentDeviceRemoteSessionUrl?: string;
    readonly agentDeviceRemoteSessionToken?: string;
    readonly webPreviewUrl?: string | null;
    readonly webPreviewToken?: string | null;
  } | null;
}

/** Job run states before the job picks the session up: waiting for the account's concurrency. */
const QUEUED_JOB = new Set(['NEW', 'IN_QUEUE']);
/** Job run states after which the session never becomes ready. */
const ENDED_JOB = new Set(['ERRORED', 'CANCELED', 'FINISHED', 'PENDING_CANCEL']);

/** EAS Simulators sessions for one Expo access token. */
export function easSessions(token: string): EasSessions {
  /** Runs one operation; a GraphQL error throws with EAS's message and error code. */
  const graphql = async <T>(query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<T> => {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const text = await response.text();
    let body: { data?: T | null; errors?: readonly GraphqlError[] };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`EAS: HTTP ${response.status}, ${text.trim().slice(0, 200)}`);
    }
    const error = body.errors?.[0];
    if (error !== undefined) throw new EasError(error.message ?? `HTTP ${response.status}`, error.extensions?.errorCode);
    if (!response.ok || body.data == null) throw new Error(`EAS: HTTP ${response.status}, no data`);
    return body.data;
  };
  return {
    async create({ platform, deviceIdentifier, ...fields }, signal) {
      const input = {
        ...fields,
        platform: platform.toUpperCase(),
        type: 'AGENT_DEVICE',
        ...(deviceIdentifier === undefined ? {} : { [platform]: { deviceIdentifier } }),
      };
      const data = await graphql<{ deviceRunSession: { createDeviceRunSession: { id: string; app: { slug: string; ownerAccount: { name: string } } } } }>(CREATE, { input }, signal);
      const { id, app } = data.deviceRunSession.createDeviceRunSession;
      return { id, url: `https://expo.dev/accounts/${encodeURIComponent(app.ownerAccount.name)}/projects/${encodeURIComponent(app.slug)}/simulator-sessions/${id}` };
    },
    async state(id, signal) {
      const data = await graphql<{ deviceRunSessions: { byId: SessionById } }>(STATE, { id }, signal);
      const session = data.deviceRunSessions.byId;
      const job = session.turtleJobRun?.status;
      const config = session.remoteConfig;
      if (session.status === 'STOPPED' || session.status === 'ERRORED') return { phase: 'ended', status: session.status.toLowerCase() };
      if (config?.agentDeviceRemoteSessionUrl !== undefined && config.agentDeviceRemoteSessionToken !== undefined) {
        const openPreviewUrl = config.webPreviewToken == null ? (config.webPreviewUrl ?? undefined) : undefined;
        return { phase: 'ready', daemonUrl: config.agentDeviceRemoteSessionUrl, daemonToken: config.agentDeviceRemoteSessionToken, openPreviewUrl };
      }
      if (job !== undefined && ENDED_JOB.has(job)) return { phase: 'ended', status: `job ${job.toLowerCase()}` };
      return { phase: job === undefined || QUEUED_JOB.has(job) ? 'queued' : 'starting' };
    },
    async stop(id, signal) {
      let job: { id: string; status: string } | null;
      try {
        const data = await graphql<{ deviceRunSession: { ensureDeviceRunSessionStopped: { turtleJobRun: { id: string; status: string } | null } } }>(STOP, { id }, signal);
        job = data.deviceRunSession.ensureDeviceRunSessionStopped.turtleJobRun;
      } catch (cause) {
        if (cause instanceof EasError && cause.code === 'NOT_FOUND_ERROR') return;
        throw cause;
      }
      if (job !== null && QUEUED_JOB.has(job.status)) await graphql(CANCEL_JOB, { id: job.id }, signal);
    },
  };
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
