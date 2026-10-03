/** TestMu AI's hosted Chrome and Edge as a `BrowserProvider` for the web engine. */

import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserRequest } from '@e2e-dev/web';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { envValue } from './env.ts';

const LT_USERNAME = 'LT_USERNAME';
const LT_ACCESS_KEY = 'LT_ACCESS_KEY';

/**
 * The TestMu AI route that serves a raw CDP endpoint. `/puppeteer` serves it
 * today. `/playwright-cdp` is TestMu AI's route for Playwright's
 * `connectOverCDP` clients and labels sessions as Playwright; use it once
 * TestMu AI serves raw CDP on it for your account.
 */
export type TestMuAIRoute = '/puppeteer' | '/playwright-cdp';

/** The browsers the web engine can attach to over CDP: Chromium ones. */
export type TestMuAIBrowser = 'Chrome' | 'MicrosoftEdge';

export interface TestMuAIOptions {
  /**
   * `worker` (default): one TestMu AI session per worker slot for the run.
   * `attempt`: a fresh session per test attempt, so each test is its own
   * TestMu AI session; rules out `headers`, `basicAuth`, and `userAgent`.
   */
  readonly scope?: BrowserProviderScope | undefined;
  /** CDP route on the hub; `/puppeteer` when absent. */
  readonly route?: TestMuAIRoute | undefined;
  /** The hub host, without a scheme or path; `cdp.lambdatest.com` when absent. */
  readonly hub?: string | undefined;
  /** `Chrome` when absent. */
  readonly browserName?: TestMuAIBrowser | undefined;
  /** `latest` when absent. */
  readonly browserVersion?: string | undefined;
  /** TestMu AI platform name, such as `Windows 11` (default) or `macOS Sequoia`. */
  readonly platform?: string | undefined;
  /** TestMu AI build name; `e2e <run id>` when absent, so one run is one build. */
  readonly build?: string | undefined;
  /**
   * Further `LT:Options` capabilities (`video`, `network`, `console`,
   * `idleTimeout`, `tunnel`, ...). `idleTimeout` is 600 seconds when absent.
   * `user`, `accessKey`, `build`, `name`, and `platform` are not accepted
   * here: the provider sets them.
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
  build: true,
  capabilities: true,
} satisfies Record<keyof TestMuAIOptions, true>);

const ROUTES: readonly string[] = ['/puppeteer', '/playwright-cdp'] satisfies TestMuAIRoute[];
const BROWSERS: readonly string[] = ['Chrome', 'MicrosoftEdge'] satisfies TestMuAIBrowser[];
const PROVIDER_CAPABILITIES = ['user', 'accessKey', 'build', 'name', 'platform'];
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

const DEFAULT_HUB = 'cdp.lambdatest.com';
const DEFAULT_ROUTE: TestMuAIRoute = '/puppeteer';
// The hub ends a CDP session after 300 s without client traffic, shorter than a slow test's gaps.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

/**
 * TestMu AI browsers for `web({ browser: testmuai() })`. A TestMu AI
 * session is its websocket: connecting to the CDP URL starts it and closing
 * the connection ends it, so `acquire` only builds the URL and `release` has
 * nothing to call. Every session is named after the target and the slot or
 * attempt, inside one build per run. `LT_USERNAME` and `LT_ACCESS_KEY` come
 * from the run's environment and never appear in a log line.
 */
export function testmuai(options: TestMuAIOptions = {}): BrowserProvider {
  if (!isRecord(options)) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuai() options must be an object');
  }
  rejectUnknownKeys('testmuai()', options, OPTION_KEYS);
  const { scope, route = DEFAULT_ROUTE, hub = DEFAULT_HUB, browserName = 'Chrome' } = options;
  if (!ROUTES.includes(route)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuai: \`route\` must be one of ${ROUTES.join(', ')}, got "${route}"`);
  }
  if (!HOST.test(hub)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuai: \`hub\` must be a host such as "${DEFAULT_HUB}", without a scheme or path, got "${hub}"`);
  }
  if (!BROWSERS.includes(browserName)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuai: \`browserName\` must be one of ${BROWSERS.join(', ')}, got "${browserName}"`);
  }
  if (options.capabilities !== undefined && !isRecord(options.capabilities)) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuai: `capabilities` must be an object of `LT:Options` fields');
  }
  const reserved = PROVIDER_CAPABILITIES.filter((key) => options.capabilities !== undefined && key in options.capabilities);
  if (reserved.length > 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `testmuai: \`capabilities\` cannot set ${reserved.map((key) => `\`${key}\``).join(', ')}; use the \`build\` and \`platform\` options, and LT_USERNAME/LT_ACCESS_KEY for credentials`,
    );
  }
  return {
    name: 'testmuai',
    ...(scope === undefined ? {} : { scope }),
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const user = envValue(request.env, LT_USERNAME);
      const accessKey = envValue(request.env, LT_ACCESS_KEY);
      if (user === undefined || accessKey === undefined) {
        throw new Error(`${LT_USERNAME} and ${LT_ACCESS_KEY} must be set`);
      }
      const label = request.attemptId ?? `slot ${request.slot + 1} of ${request.slots}`;
      const build = options.build ?? `e2e ${request.runId}`;
      const name = `e2e ${request.targetName} ${label}`;
      const capabilities = {
        browserName,
        browserVersion: options.browserVersion ?? 'latest',
        'LT:Options': {
          idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
          ...options.capabilities,
          platform: options.platform ?? 'Windows 11',
          build,
          name,
          user,
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

/** True for a plain object. Config runs as JavaScript, so the types alone are no guard. */
function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
