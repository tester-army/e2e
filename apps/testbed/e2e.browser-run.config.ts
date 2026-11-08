import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { browserRun } from '@e2e-dev/browser-run';

const url = process.env.BROWSER_RUN_TEST_URL;

if (!url) throw new Error('Set BROWSER_RUN_TEST_URL to an HTTPS deployment of the testbed pages');

const scope = process.env.BROWSER_RUN_SCOPE === 'attempt' ? 'attempt' : 'worker';

export default {
  projectId: 'e2e.browser-run.live',
  targets: [{ name: 'cloudflare', engine: web({ browser: browserRun({ scope, liveView: process.env.BROWSER_RUN_LIVE_VIEW === '1' }) }), app: { url } }],
  tests: [
    'tests/forms.e2e.ts',
    ...(scope === 'worker' ? ['tests/todos.e2e.ts'] : []),
    'tests/browser.e2e.ts',
    'tests-browser-run/browser-run.e2e.ts',
  ],
  workers: 2,
  retries: 0,
  trace: 'on',
  video: 'on',
  timeout: 120_000,
} satisfies E2EConfig;
