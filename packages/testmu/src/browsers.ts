/** TestMu AI's hosted Chrome and Edge as a `BrowserProvider` for the web engine. */

import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserRequest } from '@e2e-dev/web';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { testmuCredentials } from './credentials.ts';

/**
 * The hub route that serves a raw CDP endpoint. `/puppeteer` serves it on
 * every machine. `/playwright-cdp` labels sessions as Playwright, but serves
 * raw CDP only on machines that run TestMu AI's newest backend, which is
 * still rolling out; elsewhere the session fails to connect.
 */
export type TestmuBrowsersRoute = '/puppeteer' | '/playwright-cdp';

/** The browsers the web engine can attach to over CDP: Chromium ones. */
export type TestmuBrowserName = 'Chrome' | 'MicrosoftEdge';

export interface TestmuBrowsersOptions {
  /**
   * `worker` (default): one TestMu AI session per worker slot for the run.
   * `attempt`: a fresh session per test attempt, so each test is its own
   * TestMu AI session; rules out `headers`, `basicAuth`, and `userAgent`.
   */
  readonly scope?: BrowserProviderScope | undefined;
  /** CDP route on the hub; `/puppeteer` when absent. `/playwright-cdp` is still rolling out (see `TestmuBrowsersRoute`). */
  readonly route?: TestmuBrowsersRoute | undefined;
  /** The hub host, without a scheme or path; `cdp.lambdatest.com` when absent. */
  readonly hub?: string | undefined;
  /** `Chrome` when absent. */
  readonly browserName?: TestmuBrowserName | undefined;
  /** `latest` when absent. */
  readonly browserVersion?: string | undefined;
  /** TestMu AI platform name, such as `Windows 11` (default) or `macOS Sequoia`. */
  readonly platform?: string | undefined;
  /** Sent as `LT:Options.project`, as `testmu()` sends its own. Defaults to `e2e`. */
  readonly project?: string | undefined;
  /** Dashboard build the sessions are grouped under. Defaults to the run id, as `testmu()`'s, so a run's device and browser sessions share one build. */
  readonly build?: string | undefined;
  /**
   * Name of every session on the dashboard, with `-<slot>` (worker scope,
   * more than one slot) or `-<attempt id>` (attempt scope) appended so each
   * session has its own. Defaults to `e2e-<run id>-<target>-<slot or attempt id>`. Slots count from 1.
   */
  readonly sessionName?: string | undefined;
  /** Country the browser's IP geolocates to, as a code TestMu AI takes: `US`, `FR`. */
  readonly geoLocation?: string | undefined;
  /** The machine's time zone, as TestMu AI takes it: `UTC+05:30`. */
  readonly timezone?: string | undefined;
  /**
   * Further `LT:Options` capabilities (`video`, `network`, `console`,
   * `idleTimeout`, `tunnel`, ...). `idleTimeout` is 600 seconds when absent.
   * `user`, `accessKey`, `build`, `name`, `project`, `platform`,
   * `geoLocation`, `timezone`, `browserName`, `browserVersion`, and a nested
   * `LT:Options` are not accepted here: the provider sets them, from the
   * environment and the options above.
   */
  readonly capabilities?: Readonly<Record<string, unknown>> | undefined;
}

const OPTION_KEYS: readonly string[] = Object.keys({
  scope: true,
  route: true,
  hub: true,
  browserName: true,
  browserVersion: true,
  platform: true,
  project: true,
  build: true,
  sessionName: true,
  geoLocation: true,
  timezone: true,
  capabilities: true,
} satisfies Record<keyof TestmuBrowsersOptions, true>);

const SCOPES: readonly string[] = ['worker', 'attempt'] satisfies BrowserProviderScope[];
const ROUTES: readonly string[] = ['/puppeteer', '/playwright-cdp'] satisfies TestmuBrowsersRoute[];
const BROWSERS: readonly string[] = ['Chrome', 'MicrosoftEdge'] satisfies TestmuBrowserName[];
const PROVIDER_CAPABILITIES = ['user', 'accessKey', 'build', 'name', 'project', 'platform', 'geoLocation', 'timezone', 'browserName', 'browserVersion', 'LT:Options'];

/** The options that are strings when given, checked at config load as `testmu()` checks its own. */
const OPTIONAL_STRING_KEYS = ['browserVersion', 'platform', 'project', 'build', 'sessionName', 'geoLocation', 'timezone'] as const;

/** The `LT:Options.project` sent when `project` is absent, as `testmu()`'s default. */
const DEFAULT_PROJECT = 'e2e';
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

const DEFAULT_HUB = 'cdp.lambdatest.com';
const DEFAULT_ROUTE: TestmuBrowsersRoute = '/puppeteer';
// The hub ends a CDP session after 300 s without client traffic, shorter than a slow test's gaps.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

/**
 * TestMu AI browsers for `web({ browser: testmuBrowsers() })`. A TestMu AI
 * session is its websocket: connecting to the CDP URL starts it and closing
 * the connection ends it, so `acquire` only builds the URL and `release` has
 * nothing to call. Every session is named after the target and the slot or
 * attempt, inside one build per run. `LT_USERNAME` and `LT_ACCESS_KEY` come
 * from the run's environment and never appear in a log line.
 */
export function testmuBrowsers(options: TestmuBrowsersOptions = {}): BrowserProvider {
  if (!isRecord(options)) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuBrowsers() options must be an object');
  }
  rejectUnknownKeys('testmuBrowsers()', options, OPTION_KEYS);
  // Only an absent value takes the default: `null` from a JavaScript config is refused like any other.
  const { scope } = options;
  const route = options.route === undefined ? DEFAULT_ROUTE : options.route;
  const hub = options.hub === undefined ? DEFAULT_HUB : options.hub;
  const browserName = options.browserName === undefined ? 'Chrome' : options.browserName;
  if (scope !== undefined && !SCOPES.includes(scope)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuBrowsers: \`scope\` must be one of ${SCOPES.join(', ')}, got ${JSON.stringify(scope)}`);
  }
  if (!ROUTES.includes(route)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuBrowsers: \`route\` must be one of ${ROUTES.join(', ')}, got "${route}"`);
  }
  if (typeof hub !== 'string' || !HOST.test(hub)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuBrowsers: \`hub\` must be a host such as "${DEFAULT_HUB}", without a scheme or path, got "${hub}"`);
  }
  if (!BROWSERS.includes(browserName)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuBrowsers: \`browserName\` must be one of ${BROWSERS.join(', ')}, got "${browserName}"`);
  }
  for (const key of OPTIONAL_STRING_KEYS) {
    const value: unknown = options[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new ConfigurationError('INVALID_CONFIG', `testmuBrowsers: \`${key}\` must be a non-empty string`);
    }
  }
  if (options.capabilities !== undefined && !isRecord(options.capabilities)) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuBrowsers: `capabilities` must be an object of `LT:Options` fields');
  }
  const reserved = PROVIDER_CAPABILITIES.filter((key) => options.capabilities !== undefined && key in options.capabilities);
  if (reserved.length > 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `testmuBrowsers: \`capabilities\` cannot set ${reserved.map((key) => `\`${key}\``).join(', ')}; use the options of the same name, and LT_USERNAME/LT_ACCESS_KEY for credentials`,
    );
  }
  return {
    name: 'testmu-browsers',
    ...(scope === undefined ? {} : { scope }),
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const { username, accessKey } = testmuCredentials(request.env);
      const label = request.attemptId ?? `slot ${request.slot + 1} of ${request.slots}`;
      const build = options.build ?? request.runId;
      const name = sessionNameFor(options.sessionName, request);
      const capabilities = {
        browserName,
        browserVersion: options.browserVersion ?? 'latest',
        'LT:Options': {
          idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
          ...options.capabilities,
          platform: options.platform ?? 'Windows 11',
          project: options.project ?? DEFAULT_PROJECT,
          build,
          name,
          ...(options.geoLocation === undefined ? {} : { geoLocation: options.geoLocation }),
          ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
          user: username,
          accessKey,
        },
      };
      request.log(`TestMu AI session "${name}" in build "${build}"`);
      return {
        // Worker-scope leases share one bounded environment variable, so the id stays short.
        id: `${request.targetName}:${label}`,
        cdpEndpoint: `wss://${hub}${route}?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`,
      };
    },
    async release(): Promise<void> {
      // Closing the CDP connection, which the engine does, ends the TestMu AI session.
    },
  };
}

/**
 * The dashboard name of a session, unique among the run's sessions of the
 * target, in `testmu()`'s format: `e2e-<run id>-<target>-<slot>` per worker
 * slot, or `-<attempt id>` in attempt scope.
 */
function sessionNameFor(sessionName: string | undefined, { runId, targetName, slot, slots, attemptId }: BrowserRequest): string {
  const suffix = attemptId ?? String(slot + 1);
  if (sessionName === undefined) return `e2e-${runId}-${targetName}-${suffix}`;
  return attemptId !== undefined || slots > 1 ? `${sessionName}-${suffix}` : sessionName;
}

/** True for a plain object. Config runs as JavaScript, so the types alone are no guard. */
function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
