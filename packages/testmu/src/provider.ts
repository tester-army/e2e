/**
 * TestMu AI's hosted Android emulators, iOS simulators, and real devices as a
 * `DeviceProvider` for the mobile engine, through agent-device's `testmu`
 * cloud provider: the provider allocates agent-device leases, and the daemon
 * holding them runs each session over TestMu AI's Appium hub.
 */

import { lstat, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { createAgentDeviceClient } from 'agent-device';
import { ConfigurationError, rejectUnknownKeys, type ProviderRecordContext, type ProviderRecording } from 'e2e/engine';
import { optionalTestmuCredentials, testmuCredentials, withDaemonCredentials, type TestmuCredentials } from './credentials.ts';
import { findSession, sessionVideoUrl, testmuApiEndpoint, type SessionRef } from './sessions.ts';

/** agent-device's name for TestMu AI, as the lease provider and the tenant. */
const PROVIDER = 'testmu';

/** Where each run's daemon keeps its state, under the project root. */
const DEFAULT_STATE_DIR = '.e2e/testmu';

/** How long an earlier run's directory under `stateDir` is kept: its daemon exits after 5 idle minutes, and its logs help with a failure until then. */
const RUN_STATE_TTL_MS = 24 * 60 * 60_000;

/** A run id, which names each run's directory under `stateDir`; nothing else there is pruned. */
const RUN_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The file that marks a run's directory as the provider's: only a marked
 * directory is ever pruned, since `stateDir` may be shared with other tools.
 * Heartbeats keep it fresh while a run holds leases.
 */
const RUN_MARKER = '.e2e-testmu-run';

/** The dashboard project sessions are grouped under when `project` is absent. */
const DEFAULT_PROJECT = 'e2e';

/**
 * The inactivity window each lease asks for, agent-device's longest, so a
 * session that takes up to 10 minutes to start keeps its lease whether
 * agent-device starts the window when the allocation begins or when it
 * completes; the heartbeat keeps it alive after that.
 */
const LEASE_TTL_MS = 10 * 60_000;

/** How often the runner heartbeats each lease it holds, well inside `LEASE_TTL_MS`. */
const HEARTBEAT_INTERVAL_MS = 2 * 60_000;

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
const OPTIONAL_STRING_KEYS = ['project', 'build', 'sessionName', 'stateDir', ...(Object.keys(DEVICE_FEATURES) as (keyof typeof DEVICE_FEATURES)[])] as const;

/** Every option `testmu()` takes, kept equal to `TestmuOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  device: true,
  osVersion: true,
  app: true,
  deviceType: true,
  project: true,
  build: true,
  sessionName: true,
  stateDir: true,
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
  /**
   * Directory for the agent-device daemon each run starts, relative to the
   * project root. Defaults to `.e2e/testmu`. Each run keeps its own
   * directory in it, marked as the provider's, and the first lease of a run
   * removes earlier runs' marked directories unchanged for more than a day.
   */
  readonly stateDir?: string | undefined;
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

/** The lease scope agent-device resolves a leased device by, as `leases.allocate` granted it. */
interface LeaseScope {
  readonly tenant: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly leaseBackend: LeaseBackend;
  readonly leaseProvider: string;
}

/** A lease's daemon and scope: what releasing it needs. */
interface LeaseHandle {
  readonly stateDir: string;
  readonly scope: LeaseScope;
  /** What a daemon the call starts authenticates with, when the caller has them. */
  readonly credentials: TestmuCredentials | undefined;
}

/**
 * TestMu AI devices for `mobile({ device: testmu({ device, osVersion, app }) })`:
 * one hosted device per worker slot, leased when the run starts and released
 * when it ends. Each lease comes from an agent-device daemon the provider
 * starts for the run under `stateDir`; allocating it starts the TestMu AI
 * session, which installs `app`, so every slot is billed from the moment it
 * is leased, whether or not a test runs on it, and releasing the lease ends it.
 * An attempt that records video links TestMu AI's recording of the whole
 * session, found by the lease's build and session name, and starting when
 * the session did. It authenticates with `LT_USERNAME` and `LT_ACCESS_KEY` from the run's
 * environment, and needs an agent-device with the `testmu` provider.
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
  /** One release per lease, shared by every caller: the engine's, and `acquire`'s own after a failure. */
  const releases = new Map<string, Promise<void>>();
  /** Stops each held lease's heartbeat, by lease id. */
  const heartbeats = new Map<string, () => void>();
  let pruning: Promise<void> | undefined;
  const release = (id: string, handle: LeaseHandle): Promise<void> => {
    heartbeats.get(id)?.();
    heartbeats.delete(id);
    let pending = releases.get(id);
    if (pending === undefined) {
      pending = releaseLease(handle);
      releases.set(id, pending);
      // A failed release may be tried again.
      pending.catch(() => releases.delete(id));
    }
    return pending;
  };
  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      if (request.appPath !== undefined) throw new Error("TestMu AI installs the app from `app`; leave the target's `app.appPath` out");
      const credentials = testmuCredentials(request.env);
      const baseDir = resolve(request.projectRoot, options.stateDir ?? DEFAULT_STATE_DIR);
      const stateDir = join(baseDir, request.runId);
      pruning ??= pruneEarlierRuns(baseDir, request.runId);
      await pruning;
      await markRun(stateDir);
      if (request.signal.aborted) throw new Error('cancelled before a lease was allocated');
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
      // Not cancellable: the daemon may grant the lease after an interrupt, and only a lease this returns or releases is ever released.
      const granted = await withDaemonCredentials(credentials, () =>
        createAgentDeviceClient({ stateDir, session: `lease-${request.slot}` }).leases.allocate({
          tenant: PROVIDER,
          runId: request.runId,
          leaseBackend,
          leaseProvider: PROVIDER,
          ttlMs: LEASE_TTL_MS,
          ...selectors,
        }),
      );
      const scope: LeaseScope = { tenant: granted.tenantId, runId: granted.runId, leaseId: granted.leaseId, leaseBackend, leaseProvider: PROVIDER };
      heartbeats.set(scope.leaseId, keepAlive({ stateDir, scope, credentials }, request.log));
      try {
        if (request.signal.aborted) throw new Error('cancelled');
        request.log(`lease ${scope.leaseId}: ${device}, ${request.platform} ${osVersion} (${deviceType}); session ${selectors.providerSessionName} started`);
        // The worker's client is created with these fields: the scope picks the lease, and the selectors match the session it holds.
        return { id: scope.leaseId, client: { stateDir, ...scope, ...selectors } };
      } catch (cause) {
        // The engine releases only leases `acquire` returned.
        const outcome = await release(scope.leaseId, { stateDir, scope, credentials }).then(
          () => 'released it',
          (releaseCause: unknown) => `releasing it failed (${messageOf(releaseCause)})`,
        );
        throw new Error(`lease ${scope.leaseId} was not handed to the run: ${messageOf(cause)}; ${outcome}`, { cause });
      }
    },
    async release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void> {
      const handle = leaseHandle(lease, optionalTestmuCredentials(context.env));
      if (handle === undefined) throw new Error(`lease ${lease.id} carries no agent-device lease scope to release`);
      await release(lease.id, handle);
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

/** Marks a run's directory as the provider's, creating it. Best effort: an unmarked directory is only never pruned. */
async function markRun(stateDir: string): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, RUN_MARKER), '');
  } catch {
    // The daemon reports a state directory it cannot use.
  }
}

/**
 * Removes the directories earlier runs left under `baseDir` once nothing in
 * them has changed for a day: only directories named after a run id and
 * holding the provider's marker, never the current run's. A run still going
 * in another process stays, since its heartbeats touch the marker and its
 * daemon writes its log. Best effort: a failure leaves them.
 */
async function pruneEarlierRuns(baseDir: string, runId: string): Promise<void> {
  const cutoff = Date.now() - RUN_STATE_TTL_MS;
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name !== runId && RUN_DIR_NAME.test(name))
      .map(async (name) => {
        const dir = join(baseDir, name);
        try {
          if (!(await lstat(dir)).isDirectory() || !(await lstat(join(dir, RUN_MARKER))).isFile()) return;
          if ((await newestChange(dir)) < cutoff) await rm(dir, { recursive: true, force: true });
        } catch {
          // Not marked, gone already, or not ours to remove.
        }
      }),
  );
}

/** The latest modification time of a directory and of each entry directly in it. */
async function newestChange(dir: string): Promise<number> {
  const times = await Promise.all([dir, ...(await readdir(dir)).map((name) => join(dir, name))].map(async (path) => (await lstat(path)).mtimeMs));
  return Math.max(...times);
}

/** Releases a lease through the daemon that granted it, which ends its TestMu AI session. A lease the daemon no longer knows counts as released. */
async function releaseLease({ stateDir, scope, credentials }: LeaseHandle): Promise<void> {
  await withDaemonCredentials(credentials, () => createAgentDeviceClient({ stateDir, session: 'release' }).leases.release(scope));
}

/**
 * Heartbeats a lease until the returned function is called, touching the
 * run's marker so pruning never takes a run that is still going. A command
 * still running does not keep its lease alive, so without this a lease can
 * lapse while the run holds it. A failed heartbeat is logged once and the next one
 * tried; it never fails the run.
 */
function keepAlive({ stateDir, scope, credentials }: LeaseHandle, log: (line: string) => void): () => void {
  const client = createAgentDeviceClient({ stateDir, session: 'heartbeat' });
  let warned = false;
  const marker = join(stateDir, RUN_MARKER);
  const timer = setInterval(() => {
    const now = new Date();
    utimes(marker, now, now).catch(() => undefined);
    withDaemonCredentials(credentials, () => client.leases.heartbeat({ ...scope, ttlMs: LEASE_TTL_MS })).catch((cause: unknown) => {
      if (warned) return;
      warned = true;
      try {
        log(`lease ${scope.leaseId}: heartbeat failed (${messageOf(cause)}); agent-device ends the lease after ${LEASE_TTL_MS / 60_000} minutes without one`);
      } catch {
        // The run's log may be closed by now.
      }
    });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The dashboard name of a slot's session, unique among the run's slots of the
 * target so `record` can find the session by it within its build.
 */
function slotSessionName(sessionName: string | undefined, { runId, targetName, slot, slots }: DeviceRequest): string {
  if (sessionName === undefined) return `e2e-${runId}-${targetName}-${slot + 1}`;
  return slots > 1 ? `${sessionName}-${slot + 1}` : sessionName;
}

/** `app` as the daemon reads it: an `lt://` id or URL as written, a local path resolved against the project root, never the daemon's working directory. */
function appSource(app: string, projectRoot: string): string {
  if (isAbsolute(app) || /^[a-z][a-z0-9+.-]*:\/\//i.test(app)) return app;
  return resolve(projectRoot, app);
}

/** The daemon and scope `acquire` put on a lease's `client`, when they are there. */
function leaseHandle(lease: DeviceLease, credentials: TestmuCredentials | undefined): LeaseHandle | undefined {
  const client = lease.client as Record<string, unknown> | undefined;
  if (client === undefined) return undefined;
  const { stateDir, tenant, runId, leaseId, leaseBackend, leaseProvider } = client;
  if (
    typeof stateDir !== 'string' ||
    typeof tenant !== 'string' ||
    typeof runId !== 'string' ||
    typeof leaseId !== 'string' ||
    (leaseBackend !== 'ios-instance' && leaseBackend !== 'android-instance') ||
    typeof leaseProvider !== 'string'
  ) {
    return undefined;
  }
  return { stateDir, scope: { tenant, runId, leaseId, leaseBackend, leaseProvider }, credentials };
}

/** The build and session name `acquire` put on a lease's `client`, when they are there. */
function sessionRef(lease: DeviceLease): SessionRef | undefined {
  const client = lease.client as Record<string, unknown> | undefined;
  const build = client?.['providerBuild'];
  const sessionName = client?.['providerSessionName'];
  if (typeof build !== 'string' || build === '' || typeof sessionName !== 'string' || sessionName === '') return undefined;
  return { build, sessionName };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
