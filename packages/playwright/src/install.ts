/** First-run browser provisioning for the Playwright backend. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BackendError, InfrastructureError } from '@e2edev/e2e/backend';
import { browserType, type BrowserName } from './browser-pool.ts';

/** Returns true when the browser's executable exists on disk. */
function isBrowserInstalled(name: BrowserName): boolean {
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
}

export interface EnsureBrowsersOptions {
  /**
   * Receives progress lines; defaults to stderr. The backend's `prepare` hands
   * the harness's `info.log` here, so a first-run download narrates through
   * the reporter rather than underneath it.
   */
  readonly log?: (line: string) => void;
  /** Injected detection for tests; defaults to an executable existence check. */
  readonly isInstalled?: (name: BrowserName) => boolean;
  /** Injected installer for tests; defaults to spawning the Playwright CLI. */
  readonly install?: (names: readonly BrowserName[], context: InstallContext) => Promise<void>;
  /** Aborts a download in progress; the run's interrupt owns it. */
  readonly signal?: AbortSignal;
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
  const isInstalled = options.isInstalled ?? isBrowserInstalled;
  const missing = [...new Set(names)].filter((name) => !isInstalled(name));
  if (missing.length === 0) return;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  log(`Downloading missing Playwright browsers (first run): ${missing.join(', ')}...`);
  const install = options.install ?? runPlaywrightInstall;
  await install(missing, { log, signal: options.signal });
  log('Browser download complete.');
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
function runPlaywrightInstall(names: readonly BrowserName[], { log, signal }: InstallContext): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new BackendError('CANCELLED', 'browser install cancelled', { retryable: false }));
      return;
    }
    const child = spawn(process.execPath, [playwrightCliPath(), 'install', ...names], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
