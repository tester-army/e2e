/**
 * Launches a local browser, or attaches to a remote Chromium, and opens a
 * WebDriver BiDi session on it. Firefox speaks BiDi natively over a
 * WebSocket; Chromium speaks CDP, so the `chromium-bidi` mapper translates,
 * in a child process (`mapper-process.ts`). Local launches run the pinned
 * builds `install.ts` keeps in the browsers cache.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EngineError, withTimeout } from 'e2e/engine';
import { browserExecutable } from '../install.ts';
import { BidiConnection, webSocketTransport, type BidiTransport } from './connection.ts';
import { releaseQuietly } from './errors.ts';
import { MAPPER_READY } from './mapper-process.ts';

/** The browsers the BiDi driver launches. WebKit has no BiDi endpoint yet. */
export type BidiBrowserName = 'chromium' | 'firefox';

/** One launched browser with its open BiDi session. */
export interface BidiBrowser {
  readonly name: BidiBrowserName;
  /** The browser's version, as the session reports it. */
  readonly version: string;
  readonly connection: BidiConnection;
  /** Whether no other client drives this browser: a launch is, a browser attached over CDP may not be. */
  readonly exclusive: boolean;
  /** Ends the session; a launched browser's process is killed and its profile removed, an attached one is left running. */
  close(): Promise<void>;
}

/** How to launch a browser for the BiDi driver. */
export interface BidiLaunchOptions {
  readonly headed: boolean;
  readonly timeoutMs: number;
  /** Overrides the pinned build's binary. */
  readonly executablePath?: string;
  /** Firefox preferences for this launch, beside the driver's own. */
  readonly firefoxPrefs?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The Chromium switches and disabled features an automated run launches
 * with, Playwright 1.64's set: no background throttling, no first-run UI,
 * nothing the browser fetches or shows on its own.
 */
const CHROMIUM_ARGS = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--disable-infobars',
  `--disable-features=${[
    'AvoidUnnecessaryBeforeUnloadCheckSync',
    'DestroyProfileOnBrowserClose',
    'DialMediaRouteProvider',
    'GlobalMediaControls',
    'HttpsUpgrades',
    'LensOverlay',
    'MediaRouter',
    'PaintHolding',
    'ThirdPartyStoragePartitioning',
    'BlockOriginHeaderModificationOnRedirect',
    'AvoidCorsURLLoaderRestartOnRedirect',
    'Translate',
    'AutoDeElevate',
    'OptimizationHints',
    'NetworkTimeServiceQuerying',
    'AimEnabled',
  ].join(',')}`,
  '--enable-features=CDPScreenshotNewSurface',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

/**
 * The Firefox preferences an automated profile takes, Playwright 1.64's BiDi
 * launcher's set (beside the Remote Agent's recommended set, which it applies on
 * start): nothing reaches the network on its own, background windows keep
 * focus and full-rate timers, and startup opens no page of its own.
 */
const FIREFOX_PREFS: Readonly<Record<string, string | number | boolean>> = {
  'app.normandy.api_url': '',
  'app.update.checkInstallTime': false,
  'app.update.disabledForTesting': true,
  'apz.content_response_timeout': 60_000,
  'ui.useOverlayScrollbars': 0,
  'browser.contentblocking.features.standard': '-tp,tpPrivate,cookieBehavior0,-cm,-fp',
  'browser.newtabpage.activity-stream.discoverystream.region-weather-config': '',
  'browser.newtabpage.activity-stream.newtabWallpapers.enabled': false,
  'browser.newtabpage.activity-stream.newtabWallpapers.v2.enabled': false,
  'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
  'browser.newtabpage.activity-stream.feeds.system.topstories': false,
  'browser.newtabpage.enabled': false,
  'browser.pagethumbnails.capturing_disabled': true,
  'browser.safebrowsing.blockedURIs.enabled': false,
  'browser.safebrowsing.downloads.enabled': false,
  'browser.safebrowsing.malware.enabled': false,
  'browser.safebrowsing.phishing.enabled': false,
  'browser.search.update': false,
  'browser.sessionstore.resume_from_crash': false,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage': 'about:blank',
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.startup.page': 0,
  'browser.tabs.disableBackgroundZombification': false,
  'browser.tabs.warnOnClose': false,
  'browser.tabs.warnOnCloseOtherTabs': false,
  'browser.tabs.warnOnOpen': false,
  'browser.translations.automaticallyPopup': false,
  'browser.uitour.enabled': false,
  'browser.urlbar.suggest.searches': false,
  'browser.warnOnQuit': false,
  'datareporting.healthreport.service.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'datareporting.usage.uploadEnabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'devtools.jsonview.enabled': false,
  'dom.disable_open_during_load': false,
  'dom.file.createInChild': true,
  'dom.ipc.reportProcessHangs': false,
  'dom.max_chrome_script_run_time': 0,
  'dom.max_script_run_time': 0,
  'dom.min_background_timeout_value': 0,
  'dom.min_background_timeout_value_without_budget_throttling': 0,
  'dom.timeout.enable_budget_timer_throttling': false,
  'dom.security.https_first': false,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 5,
  'extensions.getAddons.cache.enabled': false,
  'extensions.installDistroAddons': false,
  'extensions.update.enabled': false,
  'extensions.update.notifyUser': false,
  'focusmanager.testmode': true,
  'general.useragent.updates.enabled': false,
  'geo.provider.testing': true,
  'geo.wifi.scan': false,
  'hangmonitor.timeout': 0,
  'layout.testing.top-level-always-active': true,
  'media.gmp-manager.updateEnabled': false,
  'media.sanity-test.disabled': true,
  'network.connectivity-service.enabled': false,
  'network.cookie.sameSite.laxByDefault': false,
  'network.http.prompt-temp-redirect': false,
  'network.http.speculative-parallel-limit': 0,
  'network.manage-offline-status': false,
  'privacy.trackingprotection.enabled': false,
  'security.certerrors.mitm.priming.enabled': false,
  'security.fileuri.strict_origin_policy': false,
  'security.notification_enable_delay': 0,
  'signon.autofillForms': false,
  'signon.rememberSignons': false,
  'startup.homepage_welcome_url': 'about:blank',
  'startup.homepage_welcome_url.additional': '',
  'toolkit.cosmeticAnimations.enabled': false,
  'toolkit.startup.max_resumed_crashes': -1,
  // Wheel actions go through the path real wheels take, so a scroll shows on the next frame, as it does in Chromium.
  'remote.events.async.wheel.enabled': true,
};

/** Launches `name` and opens a BiDi session, bounded by `options.timeoutMs`. */
export async function launchBidiBrowser(name: BidiBrowserName, options: BidiLaunchOptions): Promise<BidiBrowser> {
  const executable = await executableFor(name, options);
  const profile = mkdtempSync(path.join(os.tmpdir(), `e2e-bidi-${name}-`));
  const child = name === 'firefox' ? spawnFirefox(executable, profile, options) : spawnChromium(executable, profile, options);
  const removeProfile = (): void => rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  try {
    const transport =
      name === 'firefox'
        ? await webSocketTransport(`${await endpointLine(child, FIREFOX_ENDPOINT, options.timeoutMs)}/session`, options.timeoutMs)
        : await chromiumMapper(endpointLine(child, CHROMIUM_ENDPOINT, options.timeoutMs), options.timeoutMs);
    const connection = new BidiConnection(transport);
    const version = await openSession(connection, options.timeoutMs).catch((cause: unknown) => {
      connection.close();
      throw cause;
    });
    return {
      name,
      version,
      connection,
      exclusive: true,
      close: async () => {
        await Promise.race([
          releaseQuietly(connection.send('browser.close', {})),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        connection.close();
        await killed(child);
        removeProfile();
      },
    };
  } catch (cause) {
    await killed(child);
    removeProfile();
    throw launchFailure(`BiDi ${name} launch failed`, cause);
  }
}

/**
 * Attaches to a running Chromium over CDP (a `ws://` DevTools URL, or the
 * `http://` endpoint that names one) through the mapper, the way a hosted
 * browser is reached. Closing ends the session and leaves the browser to its
 * host.
 */
export async function connectBidiOverCdp(endpoint: string, timeoutMs: number): Promise<BidiBrowser> {
  let connection: BidiConnection | undefined;
  try {
    connection = new BidiConnection(await chromiumMapper(webSocketDebuggerUrl(endpoint, timeoutMs), timeoutMs));
    const open = connection;
    const version = await openSession(open, timeoutMs);
    return {
      name: 'chromium',
      version,
      connection: open,
      exclusive: false,
      close: async () => {
        await Promise.race([releaseQuietly(open.send('session.end', {})), new Promise((resolve) => setTimeout(resolve, 2_000))]);
        open.close();
      },
    };
  } catch (cause) {
    connection?.close();
    throw launchFailure('BiDi attach over CDP failed', cause);
  }
}

/** A launch or attach failure as the engine reports it: a classified error passes, anything else names what failed. */
function launchFailure(what: string, cause: unknown): EngineError {
  if (cause instanceof EngineError) return cause;
  return new EngineError('ENGINE_FAILURE', `${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
}

/** The browser-wide DevTools WebSocket URL of `endpoint`: as given for `ws(s)://`, read from `/json/version` for `http(s)://`. */
async function webSocketDebuggerUrl(endpoint: string, timeoutMs: number): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(timeoutMs) });
  const version: unknown = await response.json();
  const url = typeof version === 'object' && version !== null ? Reflect.get(version, 'webSocketDebuggerUrl') : undefined;
  if (typeof url !== 'string') throw new Error(`${endpoint}/json/version names no webSocketDebuggerUrl`);
  return url;
}

/**
 * Opens the session within `timeoutMs` and returns the browser's version. A
 * user prompt stays open for the driver to route
 * (`browsingContext.userPromptOpened`), as Playwright hands each dialog to
 * its listener; certificate errors fail navigation, as Playwright's default
 * `ignoreHTTPSErrors: false` does.
 */
async function openSession(connection: BidiConnection, timeoutMs: number): Promise<string> {
  const session = await withTimeout(
    connection.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: { default: 'ignore' } } } }),
    timeoutMs,
    () => new EngineError('ENGINE_FAILURE', `the browser opened no BiDi session within ${timeoutMs}ms`, { retryable: false }),
  );
  return session.capabilities.browserVersion;
}

const FIREFOX_ENDPOINT = /WebDriver BiDi listening on (ws:\/\/\S+)/;
const CHROMIUM_ENDPOINT = /DevTools listening on (ws:\/\/\S+)/;

/** The binary to launch: the override, else the pinned build (the headless shell for headless chromium). */
async function executableFor(name: BidiBrowserName, options: BidiLaunchOptions): Promise<string> {
  return options.executablePath ?? browserExecutable(name, options.headed);
}

/** Spawns Firefox on a fresh profile with the driver's preferences, its BiDi endpoint on a free port. */
function spawnFirefox(executable: string, profile: string, options: BidiLaunchOptions): ChildProcess {
  const prefs = Object.entries({ ...FIREFOX_PREFS, ...options.firefoxPrefs }).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
  writeFileSync(path.join(profile, 'user.js'), `${prefs.join('\n')}\n`);
  const args = ['--remote-debugging-port=0', '--profile', profile, '-no-remote', ...(options.headed ? ['--foreground'] : ['--headless'])];
  return spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
}

/** Spawns Chromium on a fresh profile with the driver's switches, its DevTools endpoint on a free port. */
function spawnChromium(executable: string, profile: string, options: BidiLaunchOptions): ChildProcess {
  const args = [
    ...CHROMIUM_ARGS,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...(options.headed
      ? []
      : ['--headless', '--hide-scrollbars', '--mute-audio', '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4']),
    '--no-startup-window',
  ];
  return spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
}

/** Resolves with the endpoint the browser prints on stderr once it listens. */
function endpointLine(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no endpoint within ${timeoutMs}ms`)), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = pattern.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      // Drained so a chatty browser never blocks on a full pipe.
      child.stderr?.removeAllListeners('data');
      child.stderr?.resume();
      resolve(match[1]);
    });
    child.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${String(code)} before listening: ${output.slice(-500)}`));
    });
  });
}

/** The mapper's entry point beside this module: the built `.js`, or the source when run from `src`. */
const MAPPER_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './mapper-process.ts' : './mapper-process.js', import.meta.url));

/**
 * Starts the `chromium-bidi` mapper in a child process at once, so it loads
 * while the browser starts, hands it `cdpUrl` when that resolves, and
 * returns the BiDi side of it, one JSON message per stdio line. Resolves
 * once the mapper serves.
 */
async function chromiumMapper(cdpUrl: Promise<string>, timeoutMs: number): Promise<BidiTransport> {
  const child = spawn(process.execPath, [MAPPER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors = `${errors}${chunk.toString()}`.slice(-4_000);
  });
  child.stdin.on('error', () => undefined);
  const why = (code: number | null, signal: NodeJS.Signals | null): string =>
    `the chromium-bidi mapper exited (${signal ?? `code ${String(code)}`})${errors.trim() === '' ? '' : `: ${errors.trim()}`}`;
  const exited = new Promise<string>((resolve) => {
    child.once('error', (cause) => resolve(`the chromium-bidi mapper could not start: ${cause.message}`));
    child.once('exit', (code, signal) => resolve(why(code, signal)));
  });
  const closeHandlers: ((reason?: string) => void)[] = [];
  void exited.then((reason) => {
    for (const handler of closeHandlers) handler(reason);
  });
  let deliver: (message: string) => void = () => undefined;
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (ready = resolve));
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === MAPPER_READY) ready();
    else deliver(line);
  });
  try {
    const url = await Promise.race([cdpUrl, exited.then((reason) => Promise.reject(new Error(reason)))]);
    child.stdin.write(`${url}\n`);
    await withTimeout(
      Promise.race([started, exited.then((reason) => Promise.reject(new Error(reason)))]),
      timeoutMs,
      () => new Error(`the chromium-bidi mapper did not start within ${timeoutMs}ms`),
    );
  } catch (cause) {
    child.kill('SIGKILL');
    throw cause;
  }
  return {
    send: (message) => {
      if (!child.stdin.writable) throw new Error('the chromium-bidi mapper is gone');
      child.stdin.write(`${message}\n`);
    },
    onMessage: (handler) => {
      deliver = handler;
    },
    onClose: (handler) => closeHandlers.push(handler),
    close: () => {
      child.stdin.end();
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    },
  };
}

/** Kills the browser's process group and resolves once it exited. */
function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  });
}
