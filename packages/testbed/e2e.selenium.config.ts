import { defineConfig } from '@e2edev/e2e';
import { playwright } from '@e2edev/playwright';

/**
 * Opt-in deterministic suite against seleniumbase.io, the practice site the
 * Selenium/SeleniumBase community uses to exercise the awkward parts of the
 * web: shadow roots, nested iframes, HTML5 drag-and-drop, canvas, native
 * dialogs, file inputs, a TinyMCE editor, broken resources, and an anti-bot
 * page. Run manually:
 *
 *   pnpm --filter @e2edev/testbed test:selenium
 *
 * Not part of CI: the site is third-party and can change or rate-limit. The
 * point is to measure the SDK against surfaces the playground cannot fake.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-selenium',
  tests: 'tests-selenium/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      platform: 'web',
      backend: playwright({ url: 'https://seleniumbase.io', allowedOrigins: ['https://seleniumbase.io'] }),
    },
  ],
  // Third-party pages over the public internet: pages such as /canvas and
  // /error_page ship hundreds of KiB of inline data, so a cold navigation is
  // slower than anything the local playground produces.
  timeout: 120_000,
  actionTimeout: 30_000,
  credentials: {
    demo: {
      username: 'demo_user',
      password: 'secret_pass',
    },
  },
});
