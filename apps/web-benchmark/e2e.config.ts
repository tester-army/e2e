import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { github } from '@e2e-dev/github';

/**
 * Deterministic suite against the benchmark scenarios. `pnpm test` builds the
 * Next.js app and serves the production build on the port below. Outside CI a
 * server already answering there is reused instead of started, which is the
 * loop for writing tests: keep `pnpm dev` running and re-run the suite.
 *
 * `benchmark.yml` runs it on every pull request; the GitHub reporter posts
 * the run as one comment there and says why when it cannot.
 */
export default {
  projectId: 'dev.e2e.web-benchmark',
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      platform: 'web',
      engine: web(),
      app: {
        url: 'http://127.0.0.1:4280',
        command: { executable: 'pnpm', args: ['run', 'start'], reuseExisting: true },
      },
    },
  ],
  // The key names this suite's comment beside the agentic one's.
  reporters: ['list', github({ key: 'web' })],
  credentials: {
    // The Login Form scenario's hardcoded account; the page prints it as a hint.
    benchmark: {
      username: 'tester@tester.army',
      password: 'benchmark123',
    },
  },
} satisfies E2EConfig;
