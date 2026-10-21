/** TestMu AI's hosted Chrome and Edge as a `BrowserProvider` for the web engine. */

import type { BrowserLease, BrowserProvider, BrowserRequest } from '@e2e-dev/web';
import { ConfigurationError, obj, rejectUnknownKeys, validateJsonValue } from 'e2e/engine';
import { testmuCredentials } from './credentials.ts';
import { DEFAULT_PROJECT, defaultSessionName } from './dashboard.ts';

/** The browsers the web engine can attach to over CDP: Chromium ones. */
export type TestmuBrowserName = 'Chrome' | 'MicrosoftEdge';

export interface TestmuBrowsersOptions {
  /** `Chrome` when absent. */
  readonly browserName?: TestmuBrowserName | undefined;
  /**
   * `browserVersion`, sent next to `browserName`, and `LT:Options` fields:
   * `platform`, `geoLocation`, `timezone`, `video`, `tunnel`, and the rest
   * TestMu AI takes. `platform` defaults to `Windows 11`, `build` to the run
   * id, `project` to `e2e`, and `idleTimeout` to 600 seconds. `user`, `accessKey`, and `name` are not
   * accepted: the provider sets them, from `LT_USERNAME`, `LT_ACCESS_KEY`,
   * and the run.
   */
  readonly capabilities?: Readonly<Record<string, unknown>> | undefined;
}

const OPTION_KEYS: readonly string[] = Object.keys({
  browserName: true,
  capabilities: true,
} satisfies Record<keyof TestmuBrowsersOptions, true>);

const BROWSERS: readonly string[] = ['Chrome', 'MicrosoftEdge'] satisfies TestmuBrowserName[];
const RESERVED_CAPABILITIES = ['user', 'accessKey', 'name'];

const CDP_ENDPOINT = 'wss://cdp.lambdatest.com/puppeteer';

// The hub refuses a session without a platform.
const DEFAULT_PLATFORM = 'Windows 11';
// The hub's Edge CDP connect never completes without a user data directory.
const EDGE_USER_DATA_DIR = '--user-data-dir=remote-debug-profile-edge';
// The hub ends a CDP session after 300 s without client traffic, shorter than a slow test's gaps.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;

/**
 * TestMu AI browsers for `web({ browser: testmuBrowsers() })`: one session
 * per worker slot. A TestMu AI session is its websocket: connecting to the
 * CDP URL starts it and closing the connection ends it, so `acquire` only
 * builds the URL and `release` has nothing to call. `LT_USERNAME` and
 * `LT_ACCESS_KEY` come from the run's environment and never appear in a log
 * line.
 */
export function testmuBrowsers(options: TestmuBrowsersOptions = {}): BrowserProvider {
  rejectUnknownKeys('testmuBrowsers()', options, OPTION_KEYS);
  // Only an absent value takes the default: `null` from a JavaScript config is refused like any other.
  const browserName = options.browserName === undefined ? 'Chrome' : options.browserName;
  if (!BROWSERS.includes(browserName)) {
    throw new ConfigurationError('INVALID_CONFIG', `testmuBrowsers: \`browserName\` must be one of ${BROWSERS.join(', ')}, got ${JSON.stringify(browserName)}`);
  }
  const capabilities: unknown = options.capabilities === undefined ? {} : options.capabilities;
  if (!isPlainObject(capabilities)) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuBrowsers: `capabilities` must be an object of `LT:Options` fields');
  }
  // An undefined value would replace a default and then vanish from the JSON.
  const defined = obj(capabilities);
  for (const [key, value] of Object.entries(defined)) {
    try {
      validateJsonValue(value, `testmuBrowsers: \`capabilities.${key}\``);
    } catch (error) {
      // JSON.stringify turns a Map or a class instance into `{}`, a Date into a string, and NaN into null, so TestMu AI would get something else.
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError('INVALID_CONFIG', error instanceof Error ? error.message : String(error));
    }
  }
  if ('LT:Options' in capabilities) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuBrowsers: pass `LT:Options` fields directly in `capabilities`, not nested under `LT:Options`');
  }
  if ('browserName' in capabilities) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuBrowsers: set `browserName` as an option, not in `capabilities`');
  }
  const reserved = RESERVED_CAPABILITIES.filter((key) => key in capabilities);
  if (reserved.length > 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `testmuBrowsers: \`capabilities\` cannot set ${reserved.map((key) => `\`${key}\``).join(', ')}; the provider names each session, and reads LT_USERNAME and LT_ACCESS_KEY from the environment`,
    );
  }
  const browserOptions: unknown = capabilities['browserOptions'];
  if (browserOptions !== undefined && !(Array.isArray(browserOptions) && browserOptions.every((flag) => typeof flag === 'string'))) {
    throw new ConfigurationError('INVALID_CONFIG', 'testmuBrowsers: `capabilities.browserOptions` must be an array of strings');
  }
  const { browserVersion, ...ltCapabilities } = defined;
  const flags: readonly string[] = browserOptions ?? [];
  if (browserName === 'MicrosoftEdge' && !flags.some((flag) => flag.startsWith('--user-data-dir='))) {
    ltCapabilities['browserOptions'] = [...flags, EDGE_USER_DATA_DIR];
  }
  return {
    name: 'testmu-browsers',
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const { username, accessKey } = testmuCredentials(request.env);
      const name = defaultSessionName(request);
      const ltOptions: Record<string, unknown> = {
        platform: DEFAULT_PLATFORM,
        project: DEFAULT_PROJECT,
        build: request.runId,
        idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
        ...ltCapabilities,
        name,
        user: username,
        accessKey,
      };
      request.log(`TestMu AI session "${name}" in build "${String(ltOptions['build'])}"`);
      return {
        id: `${request.targetName}:slot-${request.slot + 1}`,
        cdpEndpoint: `${CDP_ENDPOINT}?capabilities=${encodeURIComponent(JSON.stringify({ browserName, ...(browserVersion === undefined ? {} : { browserVersion }), 'LT:Options': ltOptions }))}`,
      };
    },
    async release(): Promise<void> {
      // Closing the CDP connection, which the engine does, ends the TestMu AI session.
    },
  };
}

/** A plain object: not null, an array, a Map, a Date, or another class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
