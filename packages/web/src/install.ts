/** First-run browser provisioning for the Playwright engine. */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { EngineError, InfrastructureError } from 'e2e/engine';
import { browserType, type BrowserName } from './browser-connection.ts';

/**
 * Whether an installed `chromium_headless_shell-<revision>` holds its executable,
 * read from the shell directory itself rather than from a path spelled out here:
 * the executable sits in a per-platform subdirectory and carries the platform's
 * extension, and both differ between the machines one run can be started on.
 */
function headlessShellInstalled(browsersPath: string, revision: string): boolean {
  const shellRoot = path.join(browsersPath, `chromium_headless_shell-${revision}`);
  // An install that never finished leaves no marker, and the collection the
  // Playwright CLI runs reads the same one.
  if (!existsSync(path.join(shellRoot, 'INSTALLATION_COMPLETE'))) return false;
  const executable = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return readdirSync(shellRoot, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(path.join(shellRoot, entry.name, executable)),
  );
}

/**
 * Whether the browser the run will launch exists on disk, or undefined when
 * this process cannot tell. Playwright resolves its browser cache from
 * `PLAYWRIGHT_BROWSERS_PATH` at module load, so the in-process check is only
 * authoritative when the run's environment agrees with this process's. A run
 * pointed at another cache is left to the CLI, which resolves against the
 * environment it is spawned with and is a no-op when nothing is missing.
 *
 * The two builds are asked for separately because a headless launch spawns
 * `chromium_headless_shell` while `executablePath()` reports the full Chrome for
 * Testing build. Answering from either alone lets the other build's absence
 * reach the launch.
 */
export function isBrowserInstalled(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): boolean | undefined {
  if (env['PLAYWRIGHT_BROWSERS_PATH'] !== process.env['PLAYWRIGHT_BROWSERS_PATH']) return undefined;
  try {
    // `executablePath()` names the cache and the revision; the shell's directory
    // is <browsersPath>/chromium_headless_shell-<that revision>.
    const executable = browserType(name).executablePath();
    const full = existsSync(executable);
    if (headed || name !== 'chromium') return full;
    if (headlessShellAt(executable)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Whether the shell beside `executable`'s full build is installed. */
function headlessShellAt(executable: string): boolean {
  const marker = `${path.sep}chromium-`;
  const at = executable.lastIndexOf(marker);
  if (at === -1) return false;
  const revision = executable.slice(at + marker.length).split(path.sep)[0] ?? '';
  return revision !== '' && headlessShellInstalled(executable.slice(0, at), revision);
}

/** The `node` arguments that run the pinned `playwright-core` CLI with `args`. */
function playwrightCliArgs(args: readonly string[]): string[] {
  const require = createRequire(import.meta.url);
  return [path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js'), ...args];
}

/**
 * Runs the pinned Playwright CLI with `args`, sharing this process's terminal,
 * and resolves to its exit code, 128 plus the signal number when a signal
 * ended it. SIGINT and SIGTERM sent to this process reach the child, so a
 * cancelled CI job does not leave a download running. Backs the `e2e-web` command,
 * and collects no revision for the same reason the run's own install does.
 */
export function runPlaywrightCli(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, playwrightCliArgs(args), {
      stdio: 'inherit',
      env: installEnvironment(),
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const settle = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    child.on('error', (error) => {
      settle();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      settle();
      resolve(code ?? (signal === null ? 1 : 128 + os.constants.signals[signal]));
    });
  });
}

/** What an installer receives besides the browser names. */
export interface InstallContext {
  /** Receives every line the installer prints: the download URL, progress, warnings. */
  readonly log: (line: string) => void;
  /** Aborts a download in progress. */
  readonly signal?: AbortSignal | undefined;
  /** Environment the installer runs with: the run's, so it fills the cache the workers will launch from. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. */
  readonly headed: boolean;
}

export interface EnsureBrowsersOptions {
  /**
   * Receives progress lines; defaults to stderr. The engine's `prepare` hands
   * the harness's `info.log` here, so a first-run download narrates through
   * the reporter rather than underneath it.
   */
  readonly log?: (line: string) => void;
  /**
   * Injected detection for tests; defaults to an executable existence check.
   * Undefined means "cannot tell here": the installer runs and decides.
   */
  readonly isInstalled?: (name: BrowserName) => boolean | undefined;
  /** Injected installer for tests; defaults to spawning the Playwright CLI. */
  readonly install?: (names: readonly BrowserName[], context: InstallContext) => Promise<void>;
  /** Aborts a download in progress; the run's interrupt owns it. */
  readonly signal?: AbortSignal;
  /** The run's environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Whether the run launches a window, so chromium is provisioned for the build
   * it will launch. Defaults to false, which is the run's own default.
   */
  readonly headed?: boolean;
}

/**
 * The browsers to install for a run, as the names the CLI takes. A headless run
 * launches chromium's shell only, and `--only-shell` keeps the full build out of
 * its download and off the disk the run has to hold. A headed run launches the
 * full build, so it asks for that.
 */
export function installArgs(names: readonly BrowserName[], headed: boolean): string[] {
  if (headed || !names.includes('chromium')) return [...names];
  return ['--only-shell', ...names];
}

/**
 * The environment the install runs in: the run's, so it fills the cache the
 * workers launch from, with the browser collection turned off.
 *
 * `playwright install` removes every revision in the browsers path that no
 * installed Playwright declares, and that path is shared with every other tool
 * on the machine. A run did not put those revisions there and cannot know
 * another tool still launches them, so the collection is off for the install
 * this spawns, which only adds what it is about to launch. A caller that sets
 * the variable keeps its own choice.
 */
function installEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PLAYWRIGHT_SKIP_BROWSER_GC: env['PLAYWRIGHT_SKIP_BROWSER_GC'] ?? '1' };
}

/**
 * Ensures the given Playwright browsers are installed, downloading any
 * missing ones via `playwright-core install`. Called from the engine's `prepare`,
 * once per run before any worker starts, so a download is never charged
 * against a launch timeout and never runs once per worker. Concurrent
 * installs (two runs at once) are still safe: the Playwright CLI serializes
 * them with a registry lock.
 */
export async function ensureBrowsersInstalled(
  names: readonly BrowserName[],
  options: EnsureBrowsersOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const headed = options.headed ?? false;
  const isInstalled = options.isInstalled ?? ((name: BrowserName) => isBrowserInstalled(name, env, headed));
  const verdicts = new Map([...new Set(names)].map((name) => [name, isInstalled(name)] as const));
  const missing = [...verdicts.keys()].filter((name) => verdicts.get(name) !== true);
  if (missing.length === 0) return;
  // The headline is only honest when every listed browser is known to be
  // absent; when the verdict is the CLI's, its own output tells the story
  // and says nothing when there is nothing to fetch.
  const knownMissing = missing.every((name) => verdicts.get(name) === false);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (knownMissing) log(`Downloading missing Playwright browsers (first run): ${missing.join(', ')}...`);
  const install = options.install ?? runPlaywrightInstall;
  await install(missing, { log, signal: options.signal, env: installEnvironment(env), headed });
  if (knownMissing) log('Browser download complete.');
}

/**
 * Forwards a child's stdout or stderr to `log` one complete line at a time.
 * The Playwright CLI redraws its progress bar with carriage returns when it
 * has a terminal; with a pipe it prints whole lines, but the splitter accepts
 * both so no partial redraw ever reaches the reporter.
 */
function forwardLines(stream: NodeJS.ReadableStream, log: (line: string) => void): void {
  let pending = '';
  const flush = (text: string) => {
    for (const line of text.split(/\r\n|\n|\r/)) {
      const trimmed = line.trimEnd();
      if (trimmed !== '') log(trimmed);
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
    if (cut === -1) return;
    flush(pending.slice(0, cut + 1));
    pending = pending.slice(cut + 1);
  });
  stream.on('end', () => flush(pending));
}

/** Spawns `node <playwright-core>/cli.js install <names>`, narrating its output through `log`. */
function runPlaywrightInstall(
  names: readonly BrowserName[],
  { log, signal, env, headed }: InstallContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new EngineError('CANCELLED', 'browser install cancelled', { retryable: false }));
      return;
    }
    const child = spawn(process.execPath, playwrightCliArgs(['install', ...installArgs(names, headed)]), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    forwardLines(child.stdout, log);
    forwardLines(child.stderr, log);
    const onAbort = () => {
      child.kill();
      reject(new EngineError('CANCELLED', 'browser install cancelled', { retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('exit', () => signal?.removeEventListener('abort', onAbort));
    child.on('error', (cause) => {
      reject(
        new InfrastructureError('BROWSER_INSTALL_FAILED', `failed to run playwright-core install: ${cause.message}`, {
          cause,
        }),
      );
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new InfrastructureError(
          'BROWSER_INSTALL_FAILED',
          `playwright-core install ${names.join(' ')} exited with code ${String(code)}; run "npx @e2e-dev/web install ${names.join(' ')}" (pnpm: "pnpm exec e2e-web install ${names.join(' ')}") manually`,
        ),
      );
    });
  });
}
