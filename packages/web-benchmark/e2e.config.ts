import type { E2EConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

/**
 * Deterministic suite against the benchmark scenarios. `pnpm test` builds the
 * Next.js app and serves the production build on the port below. Outside CI a
 * server already answering there is reused instead of started, which is the
 * loop for writing tests: keep `pnpm dev` running and re-run the suite.
 */
export default {
  specVersion: '0.1',
  projectId: 'dev.e2e.web-benchmark',
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      platform: 'web',
      engine: playwright({
        url: 'http://127.0.0.1:4280',
        command: { executable: 'pnpm', args: ['run', 'start'], reuseExisting: true },
      }),
    },
  ],
  credentials: {
    // The Login Form scenario's hardcoded account; the page prints it as a hint.
    benchmark: {
      username: 'tester@tester.army',
      password: 'benchmark123',
    },
  },
} satisfies E2EConfig;
