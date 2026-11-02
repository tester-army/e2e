/**
 * BrowserStack App Automate's real Android and iOS devices as a
 * `DeviceProvider` for the mobile engine, through agent-device's built-in
 * `browserstack` provider: each lease comes from its own agent-device daemon,
 * which runs the session over BrowserStack's Appium hub.
 */

import { isAbsolute, resolve } from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { agentDeviceLeases, type LeaseSelectors } from '@e2e-dev/mobile/lease';
import { ConfigurationError, rejectUnknownKeys, type ProviderRecordContext, type ProviderRecording } from 'e2e/engine';
import { browserstackCredentials, type BrowserStackCredentials } from './credentials.ts';
import { browserstackApiEndpoint, findSession, uploadAppFromUrl, type SessionRef } from './sessions.ts';

/** agent-device's name for BrowserStack, as the lease provider and the tenant. */
const PROVIDER = 'browserstack';

/** The dashboard project sessions are grouped under when `project` is absent. */
const DEFAULT_PROJECT = 'e2e';

const ORIENTATIONS: ReadonlySet<string> = new Set(['portrait', 'landscape']);

/** How config load checks one option, and the agent-device lease key it is allocated under when it is a device feature. */
interface OptionSpec {
  /** A string that must be given, a string when given, or a boolean when given. */
  readonly kind: 'required' | 'string' | 'boolean';
  readonly leaseKey?: Exclude<keyof LeaseSelectors, 'device'>;
}

/** Every option `browserstack()` takes, kept equal to `BrowserStackOptions` by the compiler. */
const OPTIONS: Readonly<Record<keyof BrowserStackOptions, OptionSpec>> = {
  device: { kind: 'required' },
  osVersion: { kind: 'required' },
  app: { kind: 'required' },
  project: { kind: 'string' },
  build: { kind: 'string' },
  sessionName: { kind: 'string' },
  orientation: { kind: 'string', leaseKey: 'providerDeviceOrientation' },
  geoLocation: { kind: 'string', leaseKey: 'providerGeoLocation' },
  timezone: { kind: 'string', leaseKey: 'providerTimezone' },
  language: { kind: 'string', leaseKey: 'providerLanguage' },
  locale: { kind: 'string', leaseKey: 'providerLocale' },
  appiumVersion: { kind: 'string', leaseKey: 'providerAppiumVersion' },
  networkProfile: { kind: 'string', leaseKey: 'providerNetworkProfile' },
  customNetwork: { kind: 'string', leaseKey: 'providerCustomNetwork' },
  noResignApp: { kind: 'boolean', leaseKey: 'providerNoResignApp' },
};

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

/**
 * BrowserStack devices for `mobile({ device: browserstack({ device, osVersion, app }) })`:
 * one real device and isolated agent-device daemon per worker slot. The
 * session starts, and installs `app`, when the daemon allocates the lease;
 * releasing the lease stops the daemon, which ends the session.
 */
export function browserstack(options: BrowserStackOptions): DeviceProvider {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new ConfigurationError('INVALID_CONFIG', 'browserstack: options must be an object with `device`, `osVersion`, and `app`');
  }
  rejectUnknownKeys('browserstack()', options, Object.keys(OPTIONS));
  const deviceFeatures: Record<string, unknown> = {};
  for (const [key, { kind, leaseKey }] of Object.entries(OPTIONS)) {
    const value: unknown = options[key as keyof BrowserStackOptions];
    checkOption(key, kind, value);
    // A flag is allocated only when set.
    if (leaseKey !== undefined && value !== undefined && value !== false) deviceFeatures[leaseKey] = value;
  }
  if (options.orientation !== undefined && !ORIENTATIONS.has(options.orientation)) {
    throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`orientation\` must be 'portrait' or 'landscape', not ${JSON.stringify(options.orientation)}`);
  }
  if (/^http:\/\//i.test(options.app)) {
    throw new ConfigurationError('INVALID_CONFIG', 'browserstack: `app` must be an https URL, a `bs://` id, or a local path, not a plain http URL');
  }
  if (options.networkProfile !== undefined && options.customNetwork !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'browserstack: set `networkProfile` or `customNetwork`, not both');
  }
  const noResignApp = options.noResignApp === true;
  const { device, osVersion, app, project, build, sessionName } = options;
  const leases = agentDeviceLeases({ provider: PROVIDER, label: 'BrowserStack' });
  /**
   * The `https` build's upload for one run, API endpoint, and account, whose
   * `bs://` id every slot of that run shares. Anything else uploads again,
   * so a later run never installs an earlier run's build, and a failed upload
   * may be tried again.
   */
  let uploaded: { key: string; id: Promise<string> } | undefined;

  function providerApp(request: DeviceRequest, credentials: BrowserStackCredentials): Promise<string> {
    if (!/^https:\/\//i.test(app)) return Promise.resolve(appSource(app, request.projectRoot));
    const endpoint = browserstackApiEndpoint(request.env);
    const key = JSON.stringify([request.runId, endpoint, credentials.username]);
    if (uploaded?.key === key) return uploaded.id;
    const upload = { key, id: uploadAppFromUrl(endpoint, credentials, app, request.signal) };
    uploaded = upload;
    // The URL may carry a signed token, so the log names the upload by its id only.
    upload.id.then((id) => {
      try {
        request.log(`uploaded the app URL as ${id}`);
      } catch {
        // The run's log may be closed by now.
      }
    }, () => { if (uploaded === upload) uploaded = undefined; });
    return upload.id;
  }

  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      if (request.appPath !== undefined) throw new Error("BrowserStack installs the app from `app`; leave the target's `app.appPath` out");
      if (noResignApp && request.platform !== 'ios') throw new ConfigurationError('INVALID_CONFIG', 'browserstack: `noResignApp` applies to iOS only');
      const credentials = browserstackCredentials(request.env);
      request.signal.throwIfAborted();
      const appId = await providerApp(request, credentials);
      request.signal.throwIfAborted();
      const selectors = {
        device,
        providerOsVersion: osVersion,
        providerApp: appId,
        providerProject: project ?? DEFAULT_PROJECT,
        providerBuild: build ?? request.runId,
        providerSessionName: slotSessionName(sessionName, request),
        ...deviceFeatures,
      } satisfies LeaseSelectors;
      return leases.acquire(request, {
        env: { BROWSERSTACK_USERNAME: credentials.username, BROWSERSTACK_ACCESS_KEY: credentials.accessKey },
        selectors,
        summary: `${device}, ${request.platform} ${osVersion}; session ${selectors.providerSessionName} reserved`,
      });
    },
    release: (lease, context) => leases.release(lease, context),
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

/** Throws `INVALID_CONFIG` unless `value` is what an option of `kind` takes. */
function checkOption(key: string, kind: OptionSpec['kind'], value: unknown): asserts value is string | boolean | undefined {
  if (kind === 'required' && (typeof value !== 'string' || value.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`${key}\` is required, as a non-empty string`);
  }
  if (value === undefined) return;
  if (kind === 'string' && (typeof value !== 'string' || value.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`${key}\` must be a non-empty string`);
  }
  if (kind === 'boolean' && typeof value !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `browserstack: \`${key}\` must be a boolean, not ${JSON.stringify(value)}`);
  }
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
