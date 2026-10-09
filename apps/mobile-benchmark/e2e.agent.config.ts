import type { E2EConfig } from 'e2e';
import { mobileTools } from '@e2e-dev/mobile/tools';
import { gateway } from 'ai';
import base, { android, ios } from './e2e.config.ts';

/**
 * Agentic suite against the same app and account as the deterministic one.
 * It runs in CI for this repository's branches (`mobile.yml`), replaying the
 * recordings committed under `.e2e/cache/` and calling the model for a step
 * with none; Android runs with `--strict-cache`, so a recording that no
 * longer replays fails its step. To record by hand, on a booted simulator or
 * emulator:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/mobile-benchmark test:agent
 *
 * `E2E_MODEL` overrides the pinned model so one suite dogfoods several
 * providers.
 */
export default {
  ...base,
  projectId: 'dev.e2e.mobile-benchmark-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  // Every agent step includes model round trips on top of device time, so
  // the deterministic budget is too tight for a loaded provider.
  timeout: 300_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna-fast'),
      // The 600-row list takes about 45 screens plus corrections, so the
      // default action budget would end it a few rows short.
      maxSteps: 80,
      judgmentTimeout: 90_000,
      tools: mobileTools(ios, android),
      context: [
        'This is the e2e mobile benchmark: a list of self-contained scenarios',
        'observed through the accessibility tree of an iOS simulator or an',
        'Android emulator. A step plays out inside the scenario screen it',
        'starts on; the back button in the top bar leaves it, so never press',
        'it unless the step says so. The system may interrupt with sheets or',
        'permission dialogs: handle them as the step demands and resume.',
      ].join(' '),
    },
  },
} satisfies E2EConfig;
