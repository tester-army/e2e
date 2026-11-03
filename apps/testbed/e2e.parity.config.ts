import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

/**
 * Playwright's own page tests at v1.64.1 (Apache-2.0, see parity/LICENSE),
 * rewritten against the public API, on chromium and firefox. Both targets
 * share one server; the path in each app URL names the browser to the tests
 * (tests-parity/helpers.ts). Run through `scripts/parity.ts`, which holds the
 * result to tests-parity/expected-gaps.txt.
 */
const command = { executable: 'node', args: ['parity/server.mjs'], env: { PORT: '4311' } };

export default {
  projectId: 'dev.e2e.testbed-parity',
  tests: 'tests-parity/**/*.e2e.ts',
  retries: 0,
  targets: (['chromium', 'firefox'] as const).map((browser) => ({
    name: browser,
    engine: web({ browser }),
    app: { url: `http://127.0.0.1:4311/${browser}/`, command },
  })),
  reporters: ['list'],
} satisfies E2EConfig;
