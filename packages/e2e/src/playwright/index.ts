/** Reference Playwright driver for web-0.1 (spec 09-drivers.md). */

import { createRequire } from 'node:module';
import { defineDriver, type Driver, type DriverContext, type DriverSession } from '../driver/index.js';
import { PlaywrightSession } from './session.js';

const require = createRequire(import.meta.url);

function playwrightVersion(): string {
  try {
    const packageJson = require('playwright/package.json') as { version: string };
    return packageJson.version;
  } catch {
    return 'unknown';
  }
}

/** Creates the reference Playwright driver instance. */
export function playwright(): Driver {
  return defineDriver({
    id: 'playwright',
    version: playwrightVersion(),
    platforms: ['web'],
    spiVersion: 1,
    capabilities: {
      fixtures: ['web'],
      artifacts: ['screenshot', 'trace'],
      state: true,
    },
    async launch(context: DriverContext): Promise<DriverSession> {
      const session = new PlaywrightSession(context);
      await session.launch();
      return session;
    },
  });
}

export default playwright;
