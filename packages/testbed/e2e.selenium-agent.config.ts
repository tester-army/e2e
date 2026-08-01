import { defineConfig } from 'e2e';

/**
 * Opt-in agentic suite against seleniumbase.io. Run manually:
 *
 *   E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:selenium-agent
 *
 * Not part of CI: every step spends real model calls against a third-party
 * site. Pairs with `e2e.selenium.config.ts`, which drives the same pages
 * deterministically — the two together are how a gap in the agent tier is told
 * apart from a gap in the locator engine.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-selenium-agent',
  app: {
    url: 'https://seleniumbase.io',
    environment: 'production',
    allowProduction: true,
    allowedOrigins: ['https://seleniumbase.io'],
  },
  tests: 'tests-selenium-agent/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', browser: 'chromium' }],
  timeout: 300_000,
  actionTimeout: 90_000,
  agent: {
    // One model for every tier. Canvas is the whole reason this suite exists on
    // this site: /canvas and /other/canvas draw everything, so pointing is the
    // only way in and pointing needs a model that is good at visual grounding.
    // That model now answers the tree-only calls too, so a canvas journey has
    // one reader from start to finish.
    //
    // Override with E2E_MODEL. E2E_VISION_MODEL still splits the vision tier
    // back out, which is how the two are compared.
    model: process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ...(process.env.E2E_VISION_MODEL === undefined
      ? {}
      : { visionModel: process.env.E2E_VISION_MODEL }),
    // The practice pages are small, but /demo_page is one wide table of ~60
    // controls plus four iframes that all get stitched into one observation.
    maxObservationBytes: 32_768,
    context: [
      'This is seleniumbase.io, a practice site for browser automation.',
      'Pages are plain HTML demos: labelled form controls in a table, tabs in a',
      'web component, small embedded documents, and a calculator keypad.',
      'Prefer the control whose accessible name matches the request exactly.',
    ].join(' '),
  },
  credentials: {
    demo: {
      username: 'demo_user',
      password: 'secret_pass',
    },
  },
});
