/** First-run browser provisioning for the Playwright backend. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { InfrastructureError } from 'e2e/backend';
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

export interface EnsureBrowsersOptions {
  /** Receives progress lines; defaults to stderr. Reports never go to stdout. */
  readonly log?: (line: string) => void;
  /** Injected detection for tests; defaults to an executable existence check. */
  readonly isInstalled?: (name: BrowserName) => boolean;
  /** Injected installer for tests; defaults to spawning the Playwright CLI. */
  readonly install?: (names: readonly BrowserName[]) => Promise<void>;
}

/**
 * Ensures the given Playwright browsers are installed, downloading any
 * missing ones via `playwright install`. Runs before any session launches so
 * downloads are not charged against launch timeouts. Concurrent installs are
 * safe: the Playwright CLI serializes them with a registry lock.
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
  await install(missing);
  log('Browser download complete.');
}

/** Spawns `node <playwright>/cli.js install <names>` with output on stderr. */
function runPlaywrightInstall(names: readonly BrowserName[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCliPath(), 'install', ...names], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);
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
