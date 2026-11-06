import { defineConfig } from 'vitest/config';

/**
 * Unit tests are pure and run fully in parallel. Integration tests own real
 * browser processes, so their concurrency is bounded: oversubscribing CPUs
 * starves them into timeouts that are indistinguishable from product failures.
 * The integration suite runs on Chromium, and again on Firefox for every file
 * whose engine the suite's browser decides (`tests/helpers/web-session.ts`).
 */
const integration = {
  include: ['tests/integration/**/*.test.ts'],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  pool: 'forks',
  maxWorkers: 3,
  minWorkers: 1,
  sequence: { groupOrder: 1 },
} as const;

/**
 * Files that never run on Firefox: they attach to Chrome over CDP, read
 * Chrome's own accessibility tree, install or launch Chromium itself, or
 * build engines that ignore the suite's browser.
 */
const CHROMIUM_ONLY = [
  'attach-browser',
  'browser-install',
  'cdp-attach',
  'cli',
  'closed-shadow-locators',
  'conformance',
  'crosscheck',
  'css-escapes',
  'full-chrome-attach',
  'hung-page',
  'label-composition',
  'provider-downloads',
  'selector-chains',
].map((name) => `tests/integration/${name}.test.ts`);

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      { test: { ...integration, name: 'integration' } },
      {
        test: {
          ...integration,
          name: 'integration-firefox',
          exclude: CHROMIUM_ONLY,
          env: { E2E_WEB_BROWSER: 'firefox' },
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
