/** Reference Playwright driver for web-0.1 (spec 09-drivers.md). */

import { DriverError, defineDriver, type Driver, type DriverContext, type DriverSession } from '../driver/index.js';
import { packageVersion } from '../internal/package-version.js';
import { BrowserPool } from './browser-pool.js';
import { PlaywrightSession, parseWebTarget } from './session.js';
import { message } from './support.js';

/** Creates the reference Playwright driver instance with a per-handle browser pool. */
export function playwright(): Driver {
  const pool = new BrowserPool();
  return defineDriver({
    id: 'playwright',
    version: packageVersion(import.meta.url, 'playwright/package.json', 'unknown'),
    platforms: ['web'],
    spiVersion: 1,
    capabilities: {
      fixtures: ['web'],
      artifacts: ['screenshot', 'trace'],
      state: true,
    },
    async launch(context: DriverContext): Promise<DriverSession> {
      const target = parseWebTarget(context.target);
      let browser;
      try {
        browser = await pool.acquire(
          target.browser,
          context.launchOptions.headed,
          context.operation.timeoutMs,
        );
      } catch (cause) {
        throw new DriverError('DRIVER_FAILURE', `browser launch failed: ${message(cause)}`, {
          retryable: false,
          cause,
        });
      }
      const session = new PlaywrightSession(context, browser);
      await session.launch();
      return session;
    },
    async dispose(): Promise<void> {
      await pool.dispose();
    },
  });
}

export default playwright;
