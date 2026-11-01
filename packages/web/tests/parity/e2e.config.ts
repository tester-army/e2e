import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

/**
 * Behavior parity: Playwright's own page tests (microsoft/playwright
 * `tests/page` at v1.64.1, Apache-2.0), rewritten against the public API.
 * Run it on both browsers (`BROWSER=chromium|firefox`); see README.md.
 */
const port = Number(process.env['PARITY_PORT'] ?? 4311);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PARITY_PORT must be a fixed port, got ${process.env['PARITY_PORT']}`);

export default {
  projectId: 'dev.e2e.web-parity',
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: web({ browser: (process.env['BROWSER'] ?? 'chromium') as 'chromium' | 'firefox' }),
      app: {
        url: `http://127.0.0.1:${port}`,
        command: { executable: 'node', args: ['server.mjs'], env: { PORT: String(port) } },
      },
    },
  ],
  reporters: ['list'],
} satisfies E2EConfig;
