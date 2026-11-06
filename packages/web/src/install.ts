/**
 * Browser provisioning for the web engine: pinned Chrome for Testing and
 * Firefox builds in a per-user cache, downloaded on first use, and the
 * ffmpeg that encodes Chromium's screencast.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { EngineError, InfrastructureError, type EngineDoctorCheck } from 'e2e/engine';
import type { BrowserName } from './browser-names.ts';

/** The Chrome for Testing build chromium runs: the headless shell headless, the full browser headed. */
export const CHROMIUM_BUILD = '157.0.8103.38';

/** The Firefox release firefox runs. */
export const FIREFOX_BUILD = 'stable_159.0.1';

/** The ffmpeg release that encodes Chromium's screencast when the system has none with VP9. */
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';

/** The SHA-256 of each platform's gzipped ffmpeg in `FFMPEG_RELEASE`, checked before it is kept. */
const FFMPEG_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
};

/** How long an install waits for another process's install of the same cache to finish. */
const LOCK_WAIT_MS = 10 * 60_000;

/** A lock older than this was left by a process that died mid-install. */
const STALE_LOCK_MS = 15 * 60_000;

/** The `@puppeteer/browsers` module, loaded the first time a browser is installed or looked up. */
const loadBrowsers = () => import('@puppeteer/browsers');

/** The puppeteer browser name of the build `name` runs in this mode. */
function buildOf(name: BrowserName, headed: boolean): { readonly browser: 'chrome' | 'chrome-headless-shell' | 'firefox'; readonly buildId: string } {
  if (name === 'firefox') return { browser: 'firefox', buildId: FIREFOX_BUILD };
  return { browser: headed ? 'chrome' : 'chrome-headless-shell', buildId: CHROMIUM_BUILD };
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

/** The executable of the build `name` runs in this mode, whether or not it is installed yet. */
export async function browserExecutable(name: BrowserName, headed: boolean, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { computeExecutablePath } = await loadBrowsers();
  const { browser, buildId } = buildOf(name, headed);
  return computeExecutablePath({ browser: browser as never, buildId, cacheDir: browsersPath(env) });
}

/** Whether the build `name` runs in this mode is on disk. */
async function isBrowserInstalled(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): Promise<boolean> {
  try {
    return existsSync(await browserExecutable(name, headed, env));
  } catch {
    return false;
  }
}

/** The `browser` check of `e2e doctor`: whether the build the run launches is installed. */
export async function browserCheck(
  name: BrowserName,
  env: NodeJS.ProcessEnv,
  headed: boolean,
  isInstalled: (name: BrowserName) => boolean | undefined | Promise<boolean | undefined> = (browser) => isBrowserInstalled(browser, env, headed),
): Promise<EngineDoctorCheck[]> {
  const installed = await isInstalled(name);
  if (installed === undefined) return [];
  if (installed) return [{ id: 'browser', status: 'pass', message: `${name} is installed` }];
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
  /** Injected detection for tests; defaults to an executable existence check. */
  readonly isInstalled?: (name: BrowserName) => boolean | undefined | Promise<boolean | undefined>;
  /** Injected installer for tests; defaults to `installBrowsers`. */
  readonly install?: (names: readonly BrowserName[], context: InstallContext) => Promise<void>;
  /** Aborts a download in progress; the run's interrupt owns it. */
  readonly signal?: AbortSignal;
  /** The run's environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. Defaults to false. */
  readonly headed?: boolean;
}

/**
 * Ensures the given browsers are installed, downloading any missing ones,
 * and for chromium the ffmpeg that encodes its screencast.
 * Called from the engine's `prepare`, once per run before any worker starts,
 * so a download is never charged against a launch timeout and never runs
 * once per worker. Concurrent installs (two runs at once) are serialized by
 * a lock in the cache.
 */
export async function ensureBrowsersInstalled(
  names: readonly BrowserName[],
  options: EnsureBrowsersOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const headed = options.headed ?? false;
  const isInstalled = options.isInstalled ?? ((name: BrowserName) => isBrowserInstalled(name, env, headed));
  const verdicts = new Map(await Promise.all([...new Set(names)].map(async (name) => [name, await isInstalled(name)] as const)));
  const missing = [...verdicts.keys()].filter((name) => verdicts.get(name) !== true);
  if (options.install === undefined && names.includes('chromium') && ffmpegExecutable(env) === undefined) {
    await installFfmpeg({ log: options.log ?? ((line: string) => process.stderr.write(`${line}\n`)), signal: options.signal, env });
  }
  if (missing.length === 0) return;
  const knownMissing = missing.every((name) => verdicts.get(name) === false);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (knownMissing) log(`Downloading missing browsers (first run): ${missing.join(', ')}...`);
  const install = options.install ?? installBrowsers;
  await install(missing, { log, signal: options.signal, env, headed });
  if (knownMissing) log('Browser download complete.');
}

/**
 * Downloads and unpacks `names` into the browsers cache, skipping any build
 * already there. Holds the cache's lock for the whole install, so two runs
 * that start at once download each build once.
 */
export async function installBrowsers(names: readonly BrowserName[], context: InstallContext): Promise<void> {
  const { install, detectBrowserPlatform } = await loadBrowsers();
  const cacheDir = browsersPath(context.env);
  const platform = detectBrowserPlatform();
  if (platform === undefined) {
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', `no browser builds for ${process.platform} ${process.arch}`);
  }
  await withCacheLock(cacheDir, context.signal, async () => {
    for (const name of new Set(names)) {
      const { browser, buildId } = buildOf(name, context.headed);
      if (existsSync(await browserExecutable(name, context.headed, context.env))) continue;
      cancelledCheck(context.signal);
      context.log(`Downloading ${browser} ${buildId} into ${cacheDir}`);
      try {
        await install({ browser: browser as never, buildId, cacheDir, platform });
      } catch (cause) {
        throw new InfrastructureError(
          'BROWSER_INSTALL_FAILED',
          `could not install ${browser} ${buildId}: ${cause instanceof Error ? cause.message : String(cause)}; run "npx @e2e-dev/web install ${name}" (pnpm: "pnpm exec e2e-web install ${name}") manually`,
          { cause },
        );
      }
    }
    if (context.withDeps === true) installSystemDeps(names, context.log);
  });
}

/** The fonts and tools a headless browser renders with on a minimal Debian or Ubuntu image. */
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
    'libxcursor1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxi6', 'libxrandr2', 'libxrender1',
  ],
};

/**
 * Installs the system packages `names` load, with apt on Debian and Ubuntu
 * (as root, else through sudo); elsewhere there is nothing to do. A package
 * Ubuntu 24.04 renamed with a `t64` suffix also takes its older name.
 */
function installSystemDeps(names: readonly BrowserName[], log: (line: string) => void): void {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/apt-get')) return;
  const packages = [...new Set([...APT_TOOLS, ...names.flatMap((name) => APT_PACKAGES[name])])];
  const wanted = packages.map((name) => (name.endsWith('t64') ? `${name} | ${name.slice(0, -3)}` : name)).join(', ');
  log(`Installing system packages: ${packages.join(' ')}`);
  const root = process.getuid?.() === 0;
  const run = (args: string[]) => spawnSync(root ? args[0]! : 'sudo', root ? args.slice(1) : args, { stdio: 'inherit', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  if (run(['apt-get', 'update']).status !== 0) throw new InfrastructureError('BROWSER_INSTALL_FAILED', 'apt-get update failed');
  if (run(['apt-get', 'satisfy', '-y', '--no-install-recommends', wanted]).status !== 0) {
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', 'apt-get could not install the browsers\' system packages');
  }
}

/** Rejects with `CANCELLED` once `signal` aborted. */
function cancelledCheck(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new EngineError('CANCELLED', 'browser install cancelled', { retryable: false });
}

/**
 * Runs `work` holding the cache's install lock, a directory only one process
 * can create. A lock older than `STALE_LOCK_MS` was left by a process that
 * died mid-install and is taken over.
 */
async function withCacheLock<T>(cacheDir: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  mkdirSync(cacheDir, { recursive: true });
  const lock = path.join(cacheDir, '.install.lock');
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    cancelledCheck(signal);
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > giveUp) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `another install still holds ${lock}`);
      await sleep(500);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Whether `executable` runs and lists the VP9 encoder the screencast needs. */
function encodesVp9(executable: string): boolean {
  const result = spawnSync(executable, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.includes('libvpx-vp9');
}

/** The cached ffmpeg's path for this platform. */
function cachedFfmpeg(env: NodeJS.ProcessEnv): string {
  return path.join(browsersPath(env), 'ffmpeg-b6.1.1', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/** The ffmpeg found on the system, memoized: `E2E_FFMPEG_PATH`, else `ffmpeg` on the PATH, when it encodes VP9. */
let systemFfmpeg: string | null | undefined;

/**
 * The ffmpeg that encodes Chromium's screencast: `E2E_FFMPEG_PATH`, else a
 * system `ffmpeg` with VP9, else the one `installFfmpeg` cached; undefined
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

/**
 * Downloads the pinned ffmpeg for this platform into the browsers cache,
 * checking its SHA-256, unless one is already there or on the system.
 */
export async function installFfmpeg(context: Pick<InstallContext, 'log' | 'signal' | 'env'>): Promise<string> {
  const existing = ffmpegExecutable(context.env);
  if (existing !== undefined) return existing;
  const key = `${process.platform}-${process.arch}`;
  const sha256 = FFMPEG_SHA256[key];
  if (sha256 === undefined) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `no ffmpeg build for ${key}; set E2E_FFMPEG_PATH to an ffmpeg with libvpx-vp9`);
  const target = cachedFfmpeg(context.env);
  return withCacheLock(browsersPath(context.env), context.signal, async () => {
    if (existsSync(target)) return target;
    const url = `${FFMPEG_RELEASE}/ffmpeg-${key}.gz`;
    context.log(`Downloading ffmpeg from ${url}`);
    const response = await fetch(url, context.signal === undefined ? {} : { signal: context.signal });
    if (!response.ok) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `ffmpeg download failed: ${response.status} ${url}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== sha256) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `ffmpeg download from ${url} has SHA-256 ${digest}, expected ${sha256}`);
    mkdirSync(path.dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    writeFileSync(partial, gunzipSync(archive));
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    return target;
  });
}
