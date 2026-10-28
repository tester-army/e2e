/**
 * TestMu AI's hosted Android emulators, iOS simulators, and real devices as a
 * `DeviceProvider` for the mobile engine, through agent-device's
 * `@agent-device/testmu` plugin: each lease comes from its own agent-device
 * daemon, which runs the session over TestMu AI's Appium hub.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys, type ProviderRecordContext, type ProviderRecording } from 'e2e/engine';
import { testmuCredentials, type TestmuCredentials } from './credentials.ts';
import { assertDriverVersion, installPlugin, startDriver, stopDriver } from './daemon.ts';
import { DEFAULT_PROJECT, defaultSessionName } from './dashboard.ts';
import { LEASE_TTL_MS, startHeartbeat } from './heartbeat.ts';
import { findSession, sessionVideoUrl, testmuApiEndpoint, type SessionRef } from './sessions.ts';

/** agent-device's name for TestMu AI, as the lease provider and the tenant. */
const PROVIDER = 'testmu';

const DEVICE_TYPES: ReadonlySet<string> = new Set(['virtual', 'real']);

const ORIENTATIONS: ReadonlySet<string> = new Set(['portrait', 'landscape']);

/** Each device-feature option and the agent-device lease key it is allocated under. */
const DEVICE_FEATURES = {
  orientation: 'providerDeviceOrientation',
  geoLocation: 'providerGeoLocation',
  timezone: 'providerTimezone',
  language: 'providerLanguage',
  locale: 'providerLocale',
  appiumVersion: 'providerAppiumVersion',
} as const satisfies Partial<Record<keyof TestmuOptions, string>>;

/** The options that are strings when given, checked at config load. */
const OPTIONAL_STRING_KEYS = ['project', 'build', 'sessionName', ...(Object.keys(DEVICE_FEATURES) as (keyof typeof DEVICE_FEATURES)[])] as const;

/** Every option `testmu()` takes, kept equal to `TestmuOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  device: true,
  osVersion: true,
  app: true,
  deviceType: true,
  project: true,
  build: true,
  sessionName: true,
  orientation: true,
  geoLocation: true,
  timezone: true,
  language: true,
  locale: true,
  appiumVersion: true,
} satisfies Record<keyof TestmuOptions, true>);

/** What `testmu()` takes: the device, its OS version, and the app TestMu AI installs on it. */
export interface TestmuOptions {
  /** Device name exactly as TestMu AI's catalog lists it: `Galaxy S22 Ultra 5G`, `iPhone 16`. */
  readonly device: string;
  /** OS version exactly as the catalog lists it for that device: `14` on Android, `18.0` on a virtual iOS device, `18` on a real one. */
  readonly osVersion: string;
  /**
   * The build TestMu AI installs on every session: an `lt://` app id, an
   * `https` URL, or a local path, resolved against the project root and
   * uploaded when the lease is allocated.
   */
  readonly app: string;
  /** `'virtual'` (default) for an emulator or simulator, `'real'` for a real device. */
  readonly deviceType?: 'virtual' | 'real' | undefined;
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
  /** Country the device's IP geolocates to, as a code TestMu AI takes: `US`, `FR`. */
  readonly geoLocation?: string | undefined;
  /** The device's time zone, as TestMu AI takes it: `UTC+05:30`. */
  readonly timezone?: string | undefined;
  /** The device's language, as a language code: `fr`. */
  readonly language?: string | undefined;
  /** The device's locale: `fr_FR`. */
  readonly locale?: string | undefined;
  /** Appium version TestMu AI starts for the session; absent, its default for the device. */
  readonly appiumVersion?: string | undefined;
}


type LeaseBackend = 'ios-instance' | 'android-instance';
type Held = { dir: string; stateDir: string; env: NodeJS.ProcessEnv; stopHeartbeat?: () => Promise<void>; releasing?: Promise<void> | undefined };

function driverEnv(env: DeviceRequest['env'], home: string, credentials: TestmuCredentials): NodeJS.ProcessEnv {
  const result = { ...env };
  // A user's daemon settings must not select a different daemon or plugin home.
  for (const key of Object.keys(result)) {
    // Keep the user's security policy on both the daemon and its clients.
    if (key === 'AGENT_DEVICE_DAEMON_POLICY') continue;
    if (key.startsWith('AGENT_DEVICE_')) delete result[key];
  }
  result.AGENT_DEVICE_HOME = home;
  result.LT_USERNAME = credentials.username;
  result.LT_ACCESS_KEY = credentials.accessKey;
  return result;
}

/**
 * TestMu AI devices for `mobile({ device: testmu({ device, osVersion, app }) })`:
 * one hosted device and isolated agent-device daemon per worker slot. Allocating
 * the lease starts the TestMu AI session, which installs `app`; releasing it
 * stops the daemon, which ends the session.
 */
export function testmu(options: TestmuOptions): DeviceProvider {
  rejectUnknownKeys('testmu()', options, OPTION_KEYS);
  for (const key of ['device', 'osVersion', 'app'] as const) {
    const value: unknown = options[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigurationError('INVALID_CONFIG', `testmu: \`${key}\` is required, as a non-empty string`);
    }
  }
  // Only an absent value takes the default: `null` from a JavaScript config is refused like any other.
  const deviceType = options.deviceType === undefined ? 'virtual' : options.deviceType;
  if (!DEVICE_TYPES.has(deviceType)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmu: \`deviceType\` must be 'virtual' or 'real', not ${JSON.stringify(deviceType)}`);
  }
  for (const key of OPTIONAL_STRING_KEYS) {
    const value: unknown = options[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new ConfigurationError('INVALID_CONFIG', `testmu: \`${key}\` must be a non-empty string`);
    }
  }
  if (options.orientation !== undefined && !ORIENTATIONS.has(options.orientation)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmu: \`orientation\` must be 'portrait' or 'landscape', not ${JSON.stringify(options.orientation)}`);
  }
  const deviceFeatures: Record<string, string> = {};
  for (const [key, leaseKey] of Object.entries(DEVICE_FEATURES)) {
    const value = options[key as keyof typeof DEVICE_FEATURES];
    if (value !== undefined) deviceFeatures[leaseKey] = value;
  }
  const { device, osVersion, app, project, build, sessionName } = options;
  const held = new Map<string, Held>();

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
      if (request.appPath !== undefined) throw new Error("TestMu AI installs the app from `app`; leave the target's `app.appPath` out");
      const credentials = testmuCredentials(request.env);
      request.signal.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), 'e2e-testmu-'));
      const home = join(dir, 'home');
      const resource: Held = { dir, stateDir: join(dir, 'state'), env: driverEnv(request.env, home, credentials) };
      const leaseBackend: LeaseBackend = request.platform === 'ios' ? 'ios-instance' : 'android-instance';
      const selectors = {
        platform: request.platform,
        target: 'mobile' as const,
        device,
        providerOsVersion: osVersion,
        providerApp: appSource(app, request.projectRoot),
        providerDeviceType: deviceType,
        providerProject: project ?? DEFAULT_PROJECT,
        providerBuild: build ?? request.runId,
        providerSessionName: slotSessionName(sessionName, request),
        ...deviceFeatures,
      };
      let id: string | undefined;
      try {
        await installPlugin(home);
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
        if (!grant.retainOnClose) throw new Error('agent-device did not acknowledge retainOnClose. Closing the engine session could end the TestMu AI lease before run-end release');
        const scope = { tenant: grant.tenantId, runId: grant.runId, leaseId: grant.leaseId, leaseBackend, leaseProvider: PROVIDER };
        resource.stopHeartbeat = await startHeartbeat(resource.stateDir, scope, request.log);
        request.log(`lease ${id}: ${device}, ${request.platform} ${osVersion} (${deviceType}); session ${selectors.providerSessionName} started`);
        // The worker's client is created with these fields: the scope picks the lease, and the selectors match the session it holds.
        return { id, client: { stateDir: resource.stateDir, ...scope, ...selectors } };
      } catch (cause) {
        // The engine releases only leases `acquire` returned.
        try {
          await release(id, resource, AbortSignal.timeout(30_000));
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `TestMu AI lease failed: ${messageOf(cause)}; cleanup also failed: ${messageOf(cleanup)}`, { cause: cleanup });
        }
        throw cause;
      }
    },
    async release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void> {
      const resource = held.get(lease.id);
      if (resource) await release(lease.id, resource, context.signal);
    },
    // Runs in the worker, from the lease alone. TestMu AI records the whole session, so its video starts when the session did.
    async record(lease: DeviceLease, context: ProviderRecordContext): Promise<ProviderRecording> {
      const calledAt = new Date().toISOString();
      const session = sessionRef(lease);
      if (session === undefined) throw new Error(`lease ${lease.id} carries no TestMu AI build and session name to find its recording by`);
      const credentials = testmuCredentials(context.env);
      const endpoint = testmuApiEndpoint(context.env);
      const found = await findSession(endpoint, credentials, session, context.signal);
      return {
        // Without a usable start time from TestMu AI, the moment recording was asked for is the closest known bound.
        startedAt: found.startedAt ?? calledAt,
        stop: async ({ signal }) => ({ url: await sessionVideoUrl(endpoint, credentials, found.id, session, signal), mediaType: 'video/mp4' }),
      };
    },
  };
}

/**
 * The dashboard name of a slot's session, unique among the run's slots of the
 * target so `record` can find the session by it within its build.
 */
function slotSessionName(sessionName: string | undefined, request: DeviceRequest): string {
  if (sessionName === undefined) return defaultSessionName(request);
  return request.slots > 1 ? `${sessionName}-${request.slot + 1}` : sessionName;
}

/** `app` as the daemon reads it: an `lt://` id or URL as written, a local path resolved against the project root, never the daemon's working directory. */
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
