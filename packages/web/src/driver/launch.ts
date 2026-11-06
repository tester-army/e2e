/**
 * Launches a local browser, or attaches to a remote Chromium, and opens a
 * WebDriver BiDi session on it. Firefox speaks BiDi natively over a
 * WebSocket; Chromium speaks CDP, so the `chromium-bidi` mapper translates,
 * in a child process (`mapper-process.ts`). Local launches run the pinned
 * builds `install/provision.ts` keeps in the browsers cache.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EngineError, raceAbort, withTimeout } from 'e2e/engine';
import { BROWSER_TRAITS, type BrowserName, type BrowserTraits } from '../browsers.ts';
import { browserExecutable } from '../install/provision.ts';
import { cancelled } from '../support.ts';
import { watchdogArgs } from './browser-watchdog.ts';
import { ChromiumCdp } from './cdp.ts';
import { BidiConnection, webSocketTransport, type BidiTransport } from './connection.ts';
import { releaseQuietly } from '../errors.ts';
import { MAPPER_READY } from './mapper-process.ts';

/** One launched browser with its open BiDi session. */
export interface BidiBrowser {
  /** What the driver does differently on this browser. */
  readonly traits: BrowserTraits;
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
  /** How long each stage of the launch may take. */
  readonly timeoutMs: number;
  /** The run's environment, which names the browsers cache the pinned build is in. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Kills the browser and fails the launch `CANCELLED` at any stage. */
  readonly signal: AbortSignal;
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
 * focus and full-rate timers, and startup opens no page of its own. Beside
 * it, `layout.css.getBoxQuads.enabled` gives pages `getBoxQuads`, which the
 * driver maps a point through a frame a rotation or 3D transform turns with.
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
  'layout.css.getBoxQuads.enabled': true,
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
  // Mouse actions too: the parent process routes them into an out-of-process (cross-site) frame, which a mouse
  // event synthesized in the top document's process never reaches.
  'remote.events.async.mouse.enabled': true,
};

/**
 * Launches `name` and opens a BiDi session, each stage bounded by
 * `options.timeoutMs`. The browser runs under a watchdog process
 * (`browser-watchdog.ts`) that kills it and removes its profile once this
 * process lets go of it, however this process ends. `signal` aborting at any
 * stage kills the browser and the mapper and fails the launch `CANCELLED`.
 */
export async function launchBidiBrowser(name: BrowserName, options: BidiLaunchOptions): Promise<BidiBrowser> {
  const { signal, timeoutMs } = options;
  if (signal.aborted) throw cancelled(`BiDi ${name} launch cancelled`);
  const executable = options.executablePath ?? (await browserExecutable(name, options.headed, options.env));
  const profile = mkdtempSync(path.join(os.tmpdir(), `e2e-bidi-${name}-`));
  let watchdog: ChildProcess;
  try {
    watchdog = LAUNCHERS[name].spawn(executable, profile, options);
  } catch (cause) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    throw launchFailure(`BiDi ${name} launch failed`, cause);
  }
  let connection: BidiConnection | undefined;
  const abandon = (): void => {
    connection?.close();
    void stopped(watchdog);
  };
  signal.addEventListener('abort', abandon, { once: true });
  try {
    connection = new BidiConnection(await LAUNCHERS[name].transport(watchdog, timeoutMs, signal));
    const open = connection;
    const traits = BROWSER_TRAITS[name];
    const version = await openSession(open, traits, timeoutMs, signal);
    return {
      traits,
      version,
      connection: open,
      exclusive: true,
      close: async () => {
        await Promise.race([
          releaseQuietly(open.send('browser.close', {})),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        open.close();
        await stopped(watchdog);
      },
    };
  } catch (cause) {
    connection?.close();
    await stopped(watchdog);
    if (signal.aborted) throw cancelled(`BiDi ${name} launch cancelled`);
    throw launchFailure(`BiDi ${name} launch failed`, cause);
  } finally {
    signal.removeEventListener('abort', abandon);
  }
}

/**
 * Attaches to a running Chromium over CDP (a `ws://` DevTools URL, or the
 * `http://` endpoint that names one) through the mapper, the way a hosted
 * browser is reached. Closing ends the session and leaves the browser to its
 * host. `signal` aborting at any stage (the endpoint fetch, the mapper start,
 * the session) stops the attach and fails it `CANCELLED`.
 */
export async function connectBidiOverCdp(endpoint: string, timeoutMs: number, signal: AbortSignal): Promise<BidiBrowser> {
  if (signal.aborted) throw cancelled('BiDi attach over CDP cancelled');
  let connection: BidiConnection | undefined;
  try {
    connection = new BidiConnection(await chromiumMapper(webSocketDebuggerUrl(endpoint, timeoutMs, signal), timeoutMs, signal));
    const open = connection;
    const version = await openSession(open, BROWSER_TRAITS.chromium, timeoutMs, signal);
    return {
      traits: BROWSER_TRAITS.chromium,
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
    if (signal.aborted) throw cancelled('BiDi attach over CDP cancelled');
    throw launchFailure('BiDi attach over CDP failed', cause);
  }
}

/** A launch or attach failure as the engine reports it: a classified error passes, anything else names what failed. */
function launchFailure(what: string, cause: unknown): EngineError {
  if (cause instanceof EngineError) return cause;
  return new EngineError('ENGINE_FAILURE', `${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
}

/** The browser-wide DevTools WebSocket URL of `endpoint`: as given for `ws(s)://`, read from `/json/version` for `http(s)://`. */
async function webSocketDebuggerUrl(endpoint: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  const version: unknown = await response.json();
  const url = typeof version === 'object' && version !== null ? Reflect.get(version, 'webSocketDebuggerUrl') : undefined;
  if (typeof url !== 'string') throw new Error(`${endpoint}/json/version names no webSocketDebuggerUrl`);
  return url;
}

/**
 * Opens the session within `timeoutMs`, unless `signal` aborts first, and
 * returns the browser's version. A
 * user prompt stays open for the driver to route
 * (`browsingContext.userPromptOpened`), as Playwright hands each dialog to
 * its listener; a file chooser is dismissed once `input.fileDialogOpened`
 * names its input, which `input.setFiles` fills, since one left open keeps
 * Firefox from opening the input's chooser again; certificate errors fail
 * navigation, as Playwright's default `ignoreHTTPSErrors: false` does.
 */
async function openSession(connection: BidiConnection, traits: BrowserTraits, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const opened = async (): Promise<string> => {
    const session = await connection.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: { default: 'ignore', file: 'dismiss' } } } });
    return traits.cdp ? chromiumVersion(connection) : session.capabilities.browserVersion;
  };
  return withTimeout(
    raceAbort(opened(), signal, 'opening the BiDi session'),
    timeoutMs,
    () => new EngineError('ENGINE_FAILURE', `the browser opened no BiDi session within ${timeoutMs}ms`, { retryable: false }),
  );
}

/**
 * Chromium's version number, from the product CDP's `Browser.getVersion`
 * names (`HeadlessChrome/157.0.8103.38`): the mapper reports the build's
 * revision hash as `browserVersion` for the headless shell.
 */
async function chromiumVersion(connection: BidiConnection): Promise<string> {
  const { product } = await ChromiumCdp.browser(connection).send('Browser.getVersion', {});
  return product.slice(product.lastIndexOf('/') + 1);
}

const FIREFOX_ENDPOINT = /WebDriver BiDi listening on (ws:\/\/\S+)/;
const CHROMIUM_ENDPOINT = /DevTools listening on (ws:\/\/\S+)/;

/** Spawns Firefox on a fresh profile with the driver's preferences, its BiDi endpoint on a free port. */
function spawnFirefox(executable: string, profile: string, options: BidiLaunchOptions): ChildProcess {
  const prefs = Object.entries({ ...FIREFOX_PREFS, ...options.firefoxPrefs }).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
  writeFileSync(path.join(profile, 'user.js'), `${prefs.join('\n')}\n`);
  const args = ['--remote-debugging-port=0', '--profile', profile, '-no-remote', ...(options.headed ? ['--foreground'] : ['--headless'])];
  return spawnWatched(executable, profile, args);
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
  return spawnWatched(executable, profile, args);
}

/** How one browser is launched: its process, and the BiDi transport to it once it listens. */
interface Launcher {
  spawn(executable: string, profile: string, options: BidiLaunchOptions): ChildProcess;
  /** Waits for the endpoint `watchdog`'s browser prints and connects to it; `signal` aborting stops the wait. */
  transport(watchdog: ChildProcess, timeoutMs: number, signal: AbortSignal): Promise<BidiTransport>;
}

/** Every browser's launcher: Firefox serves BiDi on a WebSocket of its own, Chromium through the mapper. */
const LAUNCHERS: Readonly<Record<BrowserName, Launcher>> = {
  chromium: {
    spawn: spawnChromium,
    transport: (watchdog, timeoutMs, signal) => chromiumMapper(endpointLine(watchdog, CHROMIUM_ENDPOINT, timeoutMs), timeoutMs, signal),
  },
  firefox: {
    spawn: spawnFirefox,
    transport: (watchdog, timeoutMs, signal) =>
      raceAbort(async () => webSocketTransport(`${await endpointLine(watchdog, FIREFOX_ENDPOINT, timeoutMs)}/session`, timeoutMs), signal, 'BiDi firefox launch'),
  },
};

/** The watchdog's entry point beside this module: the built `.js`, or the source when run from `src`. */
const WATCHDOG_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './browser-watchdog.ts' : './browser-watchdog.js', import.meta.url));

/**
 * Spawns the browser under its watchdog, which holds this process's end of
 * a stdin pipe: the browser's stderr comes through the watchdog's, and the
 * browser and its profile go once this process closes the pipe or exits.
 */
function spawnWatched(executable: string, profile: string, args: readonly string[]): ChildProcess {
  const watchdog = spawn(process.execPath, [WATCHDOG_ENTRY, ...watchdogArgs(profile, executable, args)], { stdio: ['pipe', 'ignore', 'pipe'] });
  watchdog.stdin?.on('error', () => undefined);
  return watchdog;
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
 * once the mapper serves; `signal` aborting first kills it.
 */
async function chromiumMapper(cdpUrl: Promise<string>, timeoutMs: number, signal: AbortSignal): Promise<BidiTransport> {
  const child = spawn(process.execPath, [MAPPER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors = `${errors}${chunk.toString()}`.slice(-4_000);
  });
  child.stdin.on('error', () => undefined);
  const why = (code: number | null, killedBy: NodeJS.Signals | null): string =>
    `the chromium-bidi mapper exited (${killedBy ?? `code ${String(code)}`})${errors.trim() === '' ? '' : `: ${errors.trim()}`}`;
  const exited = new Promise<string>((resolve) => {
    child.once('error', (cause) => resolve(`the chromium-bidi mapper could not start: ${cause.message}`));
    child.once('exit', (code, killedBy) => resolve(why(code, killedBy)));
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
    const url = await raceAbort(Promise.race([cdpUrl, exited.then((reason) => Promise.reject(new Error(reason)))]), signal, 'starting the chromium-bidi mapper');
    child.stdin.write(`${url}\n`);
    await withTimeout(
      raceAbort(Promise.race([started, exited.then((reason) => Promise.reject(new Error(reason)))]), signal, 'starting the chromium-bidi mapper'),
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

/**
 * Closes the watchdog's stdin, which kills the browser and removes its
 * profile, and resolves once the watchdog exited; a watchdog that outlives
 * its grace is killed.
 */
function stopped(watchdog: ChildProcess): Promise<void> {
  if (watchdog.exitCode !== null || watchdog.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      watchdog.kill('SIGKILL');
      resolve();
    }, WATCHDOG_EXIT_MS);
    watchdog.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    watchdog.stdin?.end();
  });
}

/** How long the watchdog gets to kill the browser and remove its profile. */
const WATCHDOG_EXIT_MS = 10_000;
