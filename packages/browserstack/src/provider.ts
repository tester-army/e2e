/**
 * BrowserStack App Automate's real Android and iOS devices as a
 * `DeviceProvider` for the mobile engine, through agent-device's built-in
 * `browserstack` provider: each lease comes from its own agent-device daemon,
 * which runs the session over BrowserStack's Appium hub.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys, type ProviderRecordContext, type ProviderRecording } from 'e2e/engine';
import { browserstackCredentials, type BrowserStackCredentials } from './credentials.ts';
import { assertDriverVersion, startDriver, stopDriver } from './daemon.ts';
import { LEASE_TTL_MS, startHeartbeat } from './heartbeat.ts';
import { browserstackApiEndpoint, findSession, uploadAppFromUrl, type SessionRef } from './sessions.ts';

/** agent-device's name for BrowserStack, as the lease provider and the tenant. */
const PROVIDER = 'browserstack';

/** The dashboard project sessions are grouped under when `project` is absent. */
const DEFAULT_PROJECT = 'e2e';

const ORIENTATIONS: ReadonlySet<string> = new Set(['portrait', 'landscape']);

/** Each device-feature option and the agent-device lease key it is allocated under. */
const DEVICE_FEATURES = {
  orientation: 'providerDeviceOrientation',
  geoLocation: 'providerGeoLocation',
  timezone: 'providerTimezone',
  language: 'providerLanguage',
  locale: 'providerLocale',
  appiumVersion: 'providerAppiumVersion',
  networkProfile: 'providerNetworkProfile',
  customNetwork: 'providerCustomNetwork',
} as const satisfies Partial<Record<keyof BrowserStackOptions, string>>;

/** The options that are strings when given, checked at config load. */
const OPTIONAL_STRING_KEYS = ['project', 'build', 'sessionName', ...(Object.keys(DEVICE_FEATURES) as (keyof typeof DEVICE_FEATURES)[])] as const;

/** Every option `browserstack()` takes, kept equal to `BrowserStackOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  device: true,
  osVersion: true,
  app: true,
  project: true,
  build: true,
  sessionName: true,
  orientation: true,
  geoLocation: true,
  timezone: true,
  language: true,
  locale: true,
  appiumVersion: true,
  networkProfile: true,
  customNetwork: true,
  noResignApp: true,
} satisfies Record<keyof BrowserStackOptions, true>);

/** What `browserstack()` takes: the device, its OS version, and the app BrowserStack installs on it. */
export interface BrowserStackOptions {
  /** Device name exactly as BrowserStack's App Automate catalog lists it: `Google Pixel 9`, `iPhone 16`. */
  readonly device: string;
  /** OS version exactly as the catalog lists it for that device: `16.0` on Android, `18` on iOS. */
  readonly osVersion: string;
  /**
   * The build BrowserStack installs on every session: a `bs://` app id; an
   * `https` URL, which BrowserStack fetches once per run; or a local path,
   * resolved against the project root and uploaded when the session starts.
   */
  readonly app: string;
  /** Dashboard project the sessions are grouped under. Defaults to `e2e`. */
  readonly project?: string | undefined;
  /** Dashboard build the sessions are grouped under. Defaults to the run id. */
  readonly build?: string | undefined;
  /**
   * Name of every session on the dashboard, with `-<slot>` appended when the
   * target leases more than one device, so each slot's session has its own.
   * Defaults to `e2e-<run id>-<target>-<slot>`. Slots count from 1.
   */
  readonly sessionName?: string | undefined;
  /** Orientation the device starts in; absent, the device's default. */
  readonly orientation?: 'portrait' | 'landscape' | undefined;
  /** Country the device's IP geolocates to, as a code BrowserStack takes: `US`, `FR`. */
  readonly geoLocation?: string | undefined;
  /** The device's time zone, as BrowserStack takes it: `New_York`. */
  readonly timezone?: string | undefined;
  /** The app's language, as BrowserStack takes it: `fr`. */
  readonly language?: string | undefined;
  /** The device's locale, as BrowserStack takes it: `fr_FR`. */
  readonly locale?: string | undefined;
  /**
   * Appium version BrowserStack starts for the session, such as `3.2.0`.
   * Absent, BrowserStack's default Appium 1.x, which lacks the `mobile:`
   * commands deep links and hardware buttons use.
   */
  readonly appiumVersion?: string | undefined;
  /** A named network condition profile, such as `4g-lte-advanced-good`. Not with `customNetwork`. */
  readonly networkProfile?: string | undefined;
  /** A custom network shape, as BrowserStack takes it. Not with `networkProfile`. */
  readonly customNetwork?: string | undefined;
  /**
   * iOS only: keep the uploaded app's signature instead of letting BrowserStack
   * re-sign it, which strips entitlements such as push notifications.
   */
  readonly noResignApp?: boolean | undefined;
}

type LeaseBackend = 'ios-instance' | 'android-instance';
type Held = { dir: string; stateDir: string; env: NodeJS.ProcessEnv; stopHeartbeat?: () => Promise<void>; releasing?: Promise<void> | undefined };

function driverEnv(env: DeviceRequest['env'], home: string, credentials: BrowserStackCredentials): NodeJS.ProcessEnv {
  const result = { ...env };
  // A user's daemon settings must not select a different daemon or connection profile.
  for (const key of Object.keys(result)) {
    // Keep the user's security policy on both the daemon and its clients.
    if (key === 'AGENT_DEVICE_DAEMON_POLICY') continue;
    if (key.startsWith('AGENT_DEVICE_')) delete result[key];
  }
  result.AGENT_DEVICE_HOME = home;
  result.BROWSERSTACK_USERNAME = credentials.username;
  result.BROWSERSTACK_ACCESS_KEY = credentials.accessKey;
  return result;
}

/**
 * BrowserStack devices for `mobile({ device: browserstack({ device, osVersion, app }) })`:
 * one real device and isolated agent-device daemon per worker slot. The
 * session starts, and installs `app`, on the slot's first device command;
 * releasing the lease stops the daemon, which ends the session.
 */
export function browserstack(options: BrowserStackOptions): DeviceProvider {
  rejectUnknownKeys('browserstack()', options, OPTION_KEYS);
  for (const key of ['device', 'osVersion', 'app'] as const) {
    const value: unknown = options[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`${key}\` is required, as a non-empty string`);
    }
  }
  for (const key of OPTIONAL_STRING_KEYS) {
    const value: unknown = options[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`${key}\` must be a non-empty string`);
    }
  }
  if (options.orientation !== undefined && !ORIENTATIONS.has(options.orientation)) {
    throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`orientation\` must be 'portrait' or 'landscape', not ${JSON.stringify(options.orientation)}`);
  }
  if (options.networkProfile !== undefined && options.customNetwork !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'browserstack: set `networkProfile` or `customNetwork`, not both');
  }
  const noResignApp: unknown = options.noResignApp;
  if (noResignApp !== undefined && typeof noResignApp !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`noResignApp\` must be a boolean, not ${JSON.stringify(noResignApp)}`);
  }
  const deviceFeatures: Record<string, string | boolean> = {};
  for (const [key, leaseKey] of Object.entries(DEVICE_FEATURES)) {
    const value = options[key as keyof typeof DEVICE_FEATURES];
    if (value !== undefined) deviceFeatures[leaseKey] = value;
  }
  if (noResignApp === true) deviceFeatures['providerNoResignApp'] = true;
  const { device, osVersion, app, project, build, sessionName } = options;
  const held = new Map<string, Held>();
  /** An `https` build is uploaded once and its `bs://` id shared by every slot; a failed upload may be tried again. */
  let uploaded: Promise<string> | undefined;

  function providerApp(request: DeviceRequest, credentials: BrowserStackCredentials): Promise<string> {
    if (!/^https?:\/\//i.test(app)) return Promise.resolve(appSource(app, request.projectRoot));
    if (uploaded === undefined) {
      const upload = uploadAppFromUrl(browserstackApiEndpoint(request.env), credentials, app, request.signal);
      uploaded = upload;
      // The URL may carry a signed token, so the log names the upload by its id only.
      upload.then((id) => request.log(`uploaded the app URL as ${id}`), () => { if (uploaded === upload) uploaded = undefined; });
    }
    return uploaded;
  }

  /** One release per lease, shared by every caller; a failed one may be tried again. */
  function release(id: string | undefined, resource: Held, signal: AbortSignal): Promise<void> {
    resource.releasing ??= (async () => {
      await resource.stopHeartbeat?.();
      await stopDriver(resource.stateDir, resource.env, signal);
      await rm(resource.dir, { recursive: true, force: true });
      if (id !== undefined) held.delete(id);
    })();
    resource.releasing.catch(() => { resource.releasing = undefined; });
    return resource.releasing;
  }

  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      assertDriverVersion(request.agentDeviceVersion);
      if (request.appPath !== undefined) throw new Error("BrowserStack installs the app from `app`; leave the target's `app.appPath` out");
      if (noResignApp === true && request.platform !== 'ios') throw new ConfigurationError('INVALID_CONFIG', 'browserstack: `noResignApp` applies to iOS only');
      const credentials = browserstackCredentials(request.env);
      request.signal.throwIfAborted();
      const appId = await providerApp(request, credentials);
      request.signal.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), 'e2e-browserstack-'));
      const resource: Held = { dir, stateDir: join(dir, 'state'), env: driverEnv(request.env, join(dir, 'home'), credentials) };
      const leaseBackend: LeaseBackend = request.platform === 'ios' ? 'ios-instance' : 'android-instance';
      const selectors = {
        platform: request.platform,
        target: 'mobile' as const,
        device,
        providerOsVersion: osVersion,
        providerApp: appId,
        providerProject: project ?? DEFAULT_PROJECT,
        providerBuild: build ?? request.runId,
        providerSessionName: slotSessionName(sessionName, request),
        ...deviceFeatures,
      };
      let id: string | undefined;
      try {
        const grant = await startDriver({
          stateDir: resource.stateDir,
          allocate: {
            tenant: PROVIDER,
            runId: request.runId,
            leaseBackend,
            leaseProvider: PROVIDER,
            ttlMs: LEASE_TTL_MS,
            // Retain the provider lease when closeApp or cleanup closes the engine session.
            // The provider releases the lease at run end.
            retainOnClose: true,
            ...selectors,
          },
        }, resource.env);
        id = grant.leaseId;
        held.set(id, resource);
        if (request.signal.aborted) throw new Error('cancelled');
        if (!grant.retainOnClose) throw new Error('agent-device did not acknowledge retainOnClose. Closing the engine session could end the BrowserStack lease before run-end release');
        const scope = { tenant: grant.tenantId, runId: grant.runId, leaseId: grant.leaseId, leaseBackend, leaseProvider: PROVIDER };
        resource.stopHeartbeat = await startHeartbeat(resource.stateDir, scope, request.log);
        request.log(`lease ${id}: ${device}, ${request.platform} ${osVersion}; session ${selectors.providerSessionName} reserved`);
        // The worker's client is created with these fields: the scope picks the lease, and the selectors match the session it holds.
        return { id, client: { stateDir: resource.stateDir, ...scope, ...selectors } };
      } catch (cause) {
        // The engine releases only leases `acquire` returned.
        try {
          await release(id, resource, AbortSignal.timeout(30_000));
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `BrowserStack lease failed: ${messageOf(cause)}; cleanup also failed: ${messageOf(cleanup)}`, { cause: cleanup });
        }
        throw cause;
      }
    },
    async release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void> {
      const resource = held.get(lease.id);
      if (resource) await release(lease.id, resource, context.signal);
    },
    // Runs in the worker, from the lease alone. BrowserStack records the whole session, so its video starts when the session did.
    async record(lease: DeviceLease, context: ProviderRecordContext): Promise<ProviderRecording> {
      const calledAt = new Date().toISOString();
      const session = sessionRef(lease);
      if (session === undefined) throw new Error(`lease ${lease.id} carries no BrowserStack build and session name to find its recording by`);
      const credentials = browserstackCredentials(context.env);
      const endpoint = browserstackApiEndpoint(context.env);
      const found = await findSession(endpoint, credentials, session, context.signal);
      return {
        // Without a usable start time from BrowserStack, the moment recording was asked for is the closest known bound.
        startedAt: found.startedAt ?? calledAt,
        stop: async ({ signal }) => {
          const ended = await findSession(endpoint, credentials, session, signal);
          if (ended.videoUrl === undefined) throw new Error(`BrowserStack session ${ended.id} (${JSON.stringify(session.sessionName)}, build ${JSON.stringify(session.build)}) reports no video URL`);
          return { url: ended.videoUrl, mediaType: 'video/mp4' };
        },
      };
    },
  };
}

/**
 * The dashboard name of a slot's session, unique among the run's slots of the
 * target so `record` can find the session by it within its build.
 */
function slotSessionName(sessionName: string | undefined, { runId, targetName, slot, slots }: DeviceRequest): string {
  if (sessionName === undefined) return `e2e-${runId}-${targetName}-${slot + 1}`;
  return slots > 1 ? `${sessionName}-${slot + 1}` : sessionName;
}

/** `app` as the daemon reads it: a `bs://` id as written, a local path resolved against the project root, never the daemon's working directory. */
function appSource(app: string, projectRoot: string): string {
  if (isAbsolute(app) || /^[a-z][a-z0-9+.-]*:\/\//i.test(app)) return app;
  return resolve(projectRoot, app);
}

/** The build and session name `acquire` put on a lease's `client`, when they are there. */
function sessionRef({ client }: DeviceLease): SessionRef | undefined {
  const build = client?.providerBuild;
  const sessionName = client?.providerSessionName;
  if (typeof build !== 'string' || build === '' || typeof sessionName !== 'string' || sessionName === '') return undefined;
  return { build, sessionName };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
