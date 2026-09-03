import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

/**
 * Opt-in suite against real public websites. Run manually:
 *
 *   pnpm --filter @e2edev/testbed test:public
 *
 * Not part of CI: public sites change and rate-limit, and the point of this
 * config is dogfooding the multi-origin policy against live hosts.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-public',
  app: {
    url: 'https://example.com',
    allowedOrigins: [
      'https://example.com',
      'https://www.iana.org',
      'https://playwright.dev',
    ],
  },
  tests: 'tests-public/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', backend: playwright() }],
})
