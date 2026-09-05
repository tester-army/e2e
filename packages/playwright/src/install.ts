/** First-run browser provisioning for the Playwright backend. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BackendError, InfrastructureError } from '@e2edev/e2e/backend';
import { browserType, type BrowserName } from './browser-connection.ts';

/**
 * Whether the browser's executable exists on disk, or undefined when this
 * process cannot tell. Playwright resolves its browser cache from
 * `PLAYWRIGHT_BROWSERS_PATH` at module load, so the in-process check is only
 * authoritative when the run's environment agrees with this process's. A run
 * pointed at another cache is left to the CLI, which resolves against the
 * environment it is spawned with and is a no-op when nothing is missing.
 */
function isBrowserInstalled(name: BrowserName, env: NodeJS.ProcessEnv): boolean | undefined {
  if (env['PLAYWRIGHT_BROWSERS_PATH'] !== process.env['PLAYWRIGHT_BROWSERS_PATH']) return undefined;
  try {
    return existsSync(browserType(name).executablePath());
  } catch {
    return false;
  }
}

/** Resolves the `playwright` CLI entry point relative to this package. */
function playwrightCliPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
}

/** What an installer receives besides the browser names. */
export interface InstallContext {
  /** Receives every line the installer prints: the download URL, progress, warnings. */
  readonly log: (line: string) => void;
  /** Aborts a download in progress. */
  readonly signal?: AbortSignal | undefined;
  /** Environment the installer runs with: the run's, so it fills the cache the workers will launch from. */
  readonly env: NodeJS.ProcessEnv;
}

export interface EnsureBrowsersOptions {
  /**
   * Receives progress lines; defaults to stderr. The backend's `prepare` hands
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
}

/**
 * Ensures the given Playwright browsers are installed, downloading any
 * missing ones via `playwright install`. Called from the backend's `prepare`,
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
  const isInstalled = options.isInstalled ?? ((name: BrowserName) => isBrowserInstalled(name, env));
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
  await install(missing, { log, signal: options.signal, env });
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

/** Spawns `node <playwright>/cli.js install <names>`, narrating its output through `log`. */
function runPlaywrightInstall(
  names: readonly BrowserName[],
  { log, signal, env }: InstallContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new BackendError('CANCELLED', 'browser install cancelled', { retryable: false }));
      return;
    }
    const child = spawn(process.execPath, [playwrightCliPath(), 'install', ...names], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    forwardLines(child.stdout, log);
    forwardLines(child.stderr, log);
    const onAbort = () => {
      child.kill();
      reject(new BackendError('CANCELLED', 'browser install cancelled', { retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('exit', () => signal?.removeEventListener('abort', onAbort));
    child.on('error', (cause) => {
      reject(
        new InfrastructureError('BROWSER_INSTALL_FAILED', `failed to run playwright install: ${cause.message}`, {
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
          `playwright install ${names.join(' ')} exited with code ${String(code)}; run "npx playwright install ${names.join(' ')}" manually`,
        ),
      );
    });
  });
}
