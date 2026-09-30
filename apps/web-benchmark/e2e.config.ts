import { maildev, type E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { github } from '@e2e-dev/github';

/** MailDev's SMTP port, which the app sends to, and its REST API's, which the tests read. */
const SMTP_PORT = 4281;
const MAILDEV_PORT = 4282;

/**
 * The benchmark app's target. With `mail`, MailDev starts before the app and
 * catches the mail the Email Verification scenario sends over SMTP; the
 * agentic suite leaves it out, since no agent test reads mail.
 */
export function benchmarkTarget(mail: boolean) {
  return {
    name: 'web',
    platform: 'web',
    engine: web({
      url: 'http://127.0.0.1:4280',
      ...(mail
        ? {
            services: [
              {
                name: 'maildev',
                executable: 'pnpm',
                args: ['exec', 'maildev', '--smtp', String(SMTP_PORT), '--web', String(MAILDEV_PORT), '--ip', '127.0.0.1', '--web-ip', '127.0.0.1'],
                readyUrl: `http://127.0.0.1:${MAILDEV_PORT}/api/healthz`,
                log: '.e2e/logs/maildev.log',
                reuseExisting: true,
              },
            ],
          }
        : {}),
      command: { executable: 'pnpm', args: ['run', 'start'], env: { MAIL_SMTP_PORT: String(SMTP_PORT) }, reuseExisting: true },
    }),
  } as const;
}

/**
 * Deterministic suite against the benchmark scenarios. `pnpm test` builds the
 * Next.js app and serves the production build on the port below. Outside CI a
 * server already answering there is reused instead of started, which is the
 * loop for writing tests: keep `pnpm dev` running and re-run the suite.
 *
 * `benchmark.yml` runs it on every pull request; the GitHub reporter posts
 * the run as one comment there and says why when it cannot.
 *
 * `email` reads back what the Email Verification scenario sends to MailDev.
 */
export default {
  projectId: 'dev.e2e.web-benchmark',
  tests: 'tests/**/*.e2e.ts',
  targets: [benchmarkTarget(true)],
  email: maildev({ url: `http://127.0.0.1:${MAILDEV_PORT}` }),
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
