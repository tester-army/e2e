/**
 * Browser provisioning for the web engine: pinned Chrome for Testing and
 * Firefox builds in a per-user cache, downloaded on first use, and the
 * ffmpeg that encodes Chromium's screencast, downloaded on first recording.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { EngineError, InfrastructureError, type EngineDoctorCheck } from 'e2e/engine';
import { browserPlatform, executablePath, installArchive, installBuild, type BrowserPlatform, type BuildName } from './browser-builds.ts';
import type { BrowserName } from './browser-names.ts';
import { mirrorOrigin } from './download.ts';
import { cancelledCheck, withCacheLock } from './install-lock.ts';

/** The Chrome for Testing build chromium runs: the headless shell headless, the full browser headed. */
export const CHROMIUM_BUILD = '157.0.8103.38';

/** The Firefox release firefox runs. */
export const FIREFOX_BUILD = 'stable_159.0.1';

/**
 * The SHA-256 of each pinned archive, by build and the vendor's platform
 * name. Firefox's come from Mozilla's `SHA256SUMS` for the release; Chrome
 * for Testing publishes none, so its were computed from the archives when
 * the build was pinned. A bump of either build updates these.
 */
const ARCHIVE_SHA256: Readonly<Record<BuildName, Readonly<Record<string, string>>>> = {
  'chrome-headless-shell': {
    'mac-arm64': 'e6a6b13551aa12f951d0891d79282606b13742837c8fa0505e1272bae116ce82',
    'mac-x64': '79821745d0a72d2ba752d981284ed0a9e6fa320dad133596941a17dba6186de3',
    linux64: 'deafffa74660b34853a4119c361fd427ac8c9fcb62db51ddb8a797cd83a4ba2d',
    'linux-arm64': 'b9b910a57b2a15eb3e55000a2339f93a973934a413ebfc6e585a50ec6c42fd6c',
    win64: '1ff4540855478ba0848e03f1ef8d455f77d058b38285df91bc34273788a73446',
  },
  chrome: {
    'mac-arm64': '3406b38b52b7d341d74450eb7b369be038c9fec9894c8b8a9e9e9f97333caf2f',
    'mac-x64': 'c6fcc2869b0d5a421e880d7bcdabe96e4261c4100e125fc4e4daf6346474efa6',
    linux64: '8cdeb344e9b2cefe59f4aea8d1d93d5d93054c03cde217665c16fc1f62e72a66',
    'linux-arm64': '5517510e61657ff43ee9ab804ecd1a499b3d5bd3caf72f097516bd6565ba5a17',
    win64: 'ae0deef27d449e1d7529df7705d609bab102de48464da13567ed3dd2ee1a0586',
  },
  firefox: {
    mac: '0c214da4439c1eb4cea28a3c141ff112d511aa32c67f9d12e91116569c8d8dda',
    'linux-x86_64': '469ce17120018e1c95411d254cf3c5f8db2dd1768a7acde5a2a089b00072ac65',
    'linux-aarch64': '847651efd44351972a281afa54845708faffb358692f551af391dd77736bbd6b',
    win64: '729af643b8e0a3809d6153a57a448cb96a01e6fa5e2e7ff782152ede6202eadd',
  },
};

/** The ffmpeg-static release that encodes Chromium's screencast when the system has none with VP9, as a path on `FFMPEG_HOST`. */
const FFMPEG_RELEASE = '/eugeneware/ffmpeg-static/releases/download/b6.1.1';

/** Where `FFMPEG_RELEASE` is downloaded from, unless `E2E_BROWSERS_DOWNLOAD_HOST` names a mirror. */
const FFMPEG_HOST = 'https://github.com';

/** The SHA-256 of each platform's gzipped ffmpeg in `FFMPEG_RELEASE`. */
const FFMPEG_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
};

/** Writes a progress line to stderr, where a command line install narrates. */
const logToStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The build `name` runs in this mode. */
function buildOf(name: BrowserName, headed: boolean): { readonly browser: BuildName; readonly buildId: string } {
  if (name === 'firefox') return { browser: 'firefox', buildId: FIREFOX_BUILD };
  return { browser: headed ? 'chrome' : 'chrome-headless-shell', buildId: CHROMIUM_BUILD };
}

/** The pinned SHA-256 of `browser`'s archive on `platform`. */
function archiveSha256(browser: BuildName, platform: BrowserPlatform): string {
  const sha256 = ARCHIVE_SHA256[browser][browser === 'firefox' ? platform.firefox : platform.chrome];
  if (sha256 === undefined) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `no pinned SHA-256 for ${browser} on ${platform.chrome}`);
  return sha256;
}

/**
 * Where browsers are kept: `E2E_BROWSERS_PATH` when set, else the user's
 * cache directory, shared by every project on the machine.
 */
export function browsersPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['E2E_BROWSERS_PATH'];
  if (configured !== undefined && configured !== '') return path.resolve(configured);
  if (process.platform === 'win32') return path.join(env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'e2e', 'browsers');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'e2e', 'browsers');
  return path.join(env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'e2e', 'browsers');
}

/** This machine's browser platform; throws `BROWSER_INSTALL_FAILED` where no build ships. */
function requirePlatform(): BrowserPlatform {
  const platform = browserPlatform();
  if (platform === undefined) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `no browser builds for ${process.platform} ${process.arch}`);
  return platform;
}

/** The executable of the build `name` runs in this mode. */
function executableOf(name: BrowserName, headed: boolean, env: NodeJS.ProcessEnv): string {
  const { browser, buildId } = buildOf(name, headed);
  return executablePath(browsersPath(env), browser, buildId, requirePlatform());
}

/** The executable of the build `name` runs in this mode, whether or not it is installed yet. */
export async function browserExecutable(name: BrowserName, headed: boolean, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return executableOf(name, headed, env);
}

/** Whether the build `name` runs in this mode is on disk. */
function isBrowserInstalled(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): boolean {
  try {
    return existsSync(executableOf(name, headed, env));
  } catch {
    return false;
  }
}

/** The `browser` check of `e2e doctor`: whether the build the run launches is installed. */
export async function browserCheck(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): Promise<EngineDoctorCheck[]> {
  if (isBrowserInstalled(name, env, headed)) return [{ id: 'browser', status: 'pass', message: `${name} is installed` }];
  return [
    {
      id: 'browser',
      status: 'warn',
      message: `${name} is not installed; the first run downloads it, or run "npx @e2e-dev/web install ${name}" now`,
    },
  ];
}

/** What an installer receives besides the browser names. */
export interface InstallContext {
  /** Receives every line the installer prints: what it downloads, and where. */
  readonly log: (line: string) => void;
  /** Aborts a download in progress. */
  readonly signal?: AbortSignal | undefined;
  /** Environment the installer runs with: the run's, so it fills the cache the workers will launch from. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. */
  readonly headed: boolean;
  /** Also installs the system libraries the browsers need on Linux (apt). */
  readonly withDeps?: boolean;
}

export interface EnsureBrowsersOptions {
  /**
   * Receives progress lines; defaults to stderr. The engine's `prepare` hands
   * the harness's `info.log` here, so a first-run download narrates through
   * the reporter rather than underneath it.
   */
  readonly log?: (line: string) => void;
  /** Aborts a download in progress; the run's interrupt owns it. */
  readonly signal?: AbortSignal;
  /** The run's environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. Defaults to false. */
  readonly headed?: boolean;
}

/**
 * Ensures the given browsers are installed, downloading any missing ones.
 * Called from the engine's `prepare`, once per run before any worker starts,
 * so a download is never charged against a launch timeout and never runs
 * once per worker.
 */
export async function ensureBrowsersInstalled(names: readonly BrowserName[], options: EnsureBrowsersOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const headed = options.headed ?? false;
  const missing = [...new Set(names)].filter((name) => !isBrowserInstalled(name, env, headed));
  if (missing.length === 0) return;
  const log = options.log ?? logToStderr;
  log(`Downloading missing browsers (first run): ${missing.join(', ')}...`);
  await installBrowsers(missing, { log, signal: options.signal, env, headed });
  log('Browser download complete.');
}

/**
 * Downloads, verifies, and unpacks `names` into the browsers cache, skipping
 * any build already there. Holds the cache's install lock for the whole
 * install, so two runs that start at once download each build once.
 */
export async function installBrowsers(names: readonly BrowserName[], context: InstallContext): Promise<void> {
  const cacheDir = browsersPath(context.env);
  const platform = requirePlatform();
  const host = mirrorOrigin(context.env);
  await withCacheLock(cacheDir, context, async (owner) => {
    if (context.withDeps === true) installSystemDeps(names, context.log);
    for (const name of new Set(names)) {
      if (isBrowserInstalled(name, context.env, context.headed)) continue;
      const { browser, buildId } = buildOf(name, context.headed);
      cancelledCheck(context.signal);
      context.log(`Downloading ${browser} ${buildId} into ${cacheDir}`);
      try {
        await installBuild({ build: browser, buildId, platform, cacheDir, sha256: archiveSha256(browser, platform), host, owner, env: context.env, signal: context.signal });
      } catch (cause) {
        cancelledCheck(context.signal);
        throw new InfrastructureError(
          'BROWSER_INSTALL_FAILED',
          `could not install ${browser} ${buildId}: ${cause instanceof Error ? cause.message : String(cause)}; run "npx @e2e-dev/web install ${name}" (pnpm: "pnpm exec e2e-web install ${name}") manually`,
          { cause },
        );
      }
    }
  });
}

/** The fonts a headless browser renders with on a minimal Debian or Ubuntu image; each one the distribution lacks is left out. */
const APT_TOOLS = ['fonts-noto-color-emoji', 'fonts-unifont', 'libfontconfig1', 'libfreetype6', 'xfonts-cyrillic', 'xfonts-scalable', 'fonts-liberation', 'fonts-ipafont-gothic', 'fonts-wqy-zenhei', 'fonts-tlwg-loma-otf', 'fonts-freefont-ttf'];

/** The Debian packages each browser loads, by their Ubuntu 24.04 names. */
const APT_PACKAGES: Readonly<Record<BrowserName, readonly string[]>> = {
  chromium: [
    'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64', 'libcairo2', 'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libgbm1',
    'libglib2.0-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3',
    'libxkbcommon0', 'libxrandr2',
  ],
  firefox: [
    'libasound2t64', 'libatk1.0-0t64', 'libcairo-gobject2', 'libcairo2', 'libdbus-1-3', 'libfontconfig1', 'libfreetype6', 'libgdk-pixbuf-2.0-0',
    'libglib2.0-0t64', 'libgtk-3-0t64', 'libpango-1.0-0', 'libpangocairo-1.0-0', 'libx11-6', 'libx11-xcb1', 'libxcb-shm0', 'libxcb1', 'libxcomposite1',
    'libxcursor1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxi6', 'libxrandr2', 'libxrender1', 'xz-utils',
  ],
};

/**
 * Installs the system packages `names` load, with apt on Debian and Ubuntu
 * (as root, else through sudo); elsewhere there is nothing to do. A package
 * Ubuntu 24.04 renamed with a `t64` suffix also takes its older name, and a
 * font the distribution does not carry is skipped.
 */
function installSystemDeps(names: readonly BrowserName[], log: (line: string) => void): void {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/apt-get')) return;
  const root = process.getuid?.() === 0;
  const run = (args: string[]) => spawnSync(root ? args[0]! : 'sudo', root ? args.slice(1) : args, { stdio: 'inherit', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  if (run(['apt-get', 'update']).status !== 0) throw new InfrastructureError('BROWSER_INSTALL_FAILED', 'apt-get update failed');
  const fonts = APT_TOOLS.filter((name) => spawnSync('apt-get', ['install', '--simulate', '--no-install-recommends', name], { stdio: 'ignore' }).status === 0);
  const packages = [...new Set([...fonts, ...names.flatMap((name) => APT_PACKAGES[name])])];
  const wanted = packages.map((name) => (name.endsWith('t64') ? `${name} | ${name.slice(0, -3)}` : name)).join(', ');
  log(`Installing system packages: ${packages.join(' ')}`);
  if (run(['apt-get', 'satisfy', '-y', '--no-install-recommends', wanted]).status !== 0) {
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', 'apt-get could not install the browsers\' system packages');
  }
}


/** Whether `executable` runs and lists the VP9 encoder the screencast needs. */
function encodesVp9(executable: string): boolean {
  const result = spawnSync(executable, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.includes('libvpx-vp9');
}

/** The cached ffmpeg's directory. */
function cachedFfmpegDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(browsersPath(env), 'ffmpeg-b6.1.1');
}

/** The cached ffmpeg's path for this platform. */
function cachedFfmpeg(env: NodeJS.ProcessEnv): string {
  return path.join(cachedFfmpegDirectory(env), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/** The ffmpeg found on the system, memoized: `E2E_FFMPEG_PATH`, else `ffmpeg` on the PATH, when it encodes VP9. */
let systemFfmpeg: string | null | undefined;

/**
 * The ffmpeg that encodes Chromium's screencast: `E2E_FFMPEG_PATH`, else a
 * system `ffmpeg` with VP9, else the one `ensureFfmpeg` cached; undefined
 * when there is none yet.
 */
export function ffmpegExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['E2E_FFMPEG_PATH'];
  if (configured !== undefined && configured !== '') return configured;
  const cached = cachedFfmpeg(env);
  if (existsSync(cached)) return cached;
  systemFfmpeg ??= encodesVp9('ffmpeg') ? 'ffmpeg' : null;
  return systemFfmpeg ?? undefined;
}

/** What `ensureFfmpeg` reports to and stops on. */
export interface FfmpegContext {
  /** Receives what it downloads; silent when omitted. */
  readonly log?: ((line: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The ffmpeg that encodes Chromium's screencast, downloading the pinned
 * build into the browsers cache when the system has none: from the
 * `E2E_BROWSERS_DOWNLOAD_HOST` mirror when set, checked against its
 * SHA-256, under the cache's install lock. Throws `UNSUPPORTED_CAPABILITY`
 * on a platform with no pinned build, and `BROWSER_INSTALL_FAILED` when the
 * download fails.
 */
export async function ensureFfmpeg(env: NodeJS.ProcessEnv, context: FfmpegContext = {}): Promise<string> {
  const existing = ffmpegExecutable(env);
  if (existing !== undefined) return existing;
  const key = `${process.platform}-${process.arch}`;
  const sha256 = FFMPEG_SHA256[key];
  if (sha256 === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `recording video on chromium needs an ffmpeg with libvpx-vp9, and none is pinned for ${key}: set E2E_FFMPEG_PATH`, { retryable: false });
  }
  const executable = cachedFfmpeg(env);
  const log = context.log ?? (() => undefined);
  await withCacheLock(browsersPath(env), { log, signal: context.signal }, async (owner) => {
    if (existsSync(executable)) return;
    const url = `${mirrorOrigin(env) ?? FFMPEG_HOST}${FFMPEG_RELEASE}/ffmpeg-${key}.gz`;
    log(`Downloading ffmpeg from ${url}`);
    try {
      await installArchive({
        url,
        sha256,
        target: cachedFfmpegDirectory(env),
        isInstalled: () => existsSync(executable),
        unpack: async (archive, root) => {
          const file = path.join(root, path.basename(executable));
          await pipeline(createReadStream(archive), createGunzip(), createWriteStream(file), context.signal === undefined ? {} : { signal: context.signal });
          chmodSync(file, 0o755);
        },
        owner,
        env,
        signal: context.signal,
      });
    } catch (cause) {
      cancelledCheck(context.signal);
      throw new InfrastructureError(
        'BROWSER_INSTALL_FAILED',
        `could not install ffmpeg: ${cause instanceof Error ? cause.message : String(cause)}; run "npx @e2e-dev/web install ffmpeg", or set E2E_FFMPEG_PATH to an ffmpeg with libvpx-vp9`,
        { cause },
      );
    }
  });
  return executable;
}
