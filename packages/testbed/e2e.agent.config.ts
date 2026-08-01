import { defineConfig } from 'e2e';

/**
 * Opt-in agentic suite against the local playground. Run manually:
 *
 *   E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:agent
 *
 * Not part of CI: every test spends real model calls and the located-action and
 * judgment tiers are structurally comparable across models, not identical.
 * `E2E_MODEL` overrides the pinned model so one suite dogfoods several
 * providers.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-agent',
  app: {
    url: 'http://127.0.0.1:4272',
    command: {
      executable: 'node',
      args: ['app/server.mjs'],
      env: { PORT: '4272' },
    },
  },
  tests: 'tests-agent/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', browser: 'chromium' }],
  // Every located action includes a model round trip, so the deterministic
  // 30 s action budget is too tight for a loaded provider. Latency is not a
  // product defect: give it room rather than reading timeouts as failures.
  timeout: 300_000,
  actionTimeout: 90_000,
  agent: {
    // One model for every tier. Visual grounding is a much higher bar than
    // accepting an image -- a flash model judges a drawn chart correctly and
    // still points at a map pin ~1.6x off in y -- so this suite already pinned
    // the stronger model for pixels. Running it everywhere costs more per run
    // and buys one reader for the whole journey, so a failure is the product's
    // or the flow's rather than a question of which model answered which step.
    //
    // Override with E2E_MODEL. E2E_VISION_MODEL still splits the vision tier
    // back out, which is how the two are compared.
    model: process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ...(process.env.E2E_VISION_MODEL === undefined
      ? {}
      : { visionModel: process.env.E2E_VISION_MODEL }),
    context: [
      'This is the e2e playground app: a small multi-page site with todos,',
      'forms, a sign-in flow, a workspace wizard, and release notes.',
      'Prefer the control whose accessible name matches the request exactly.',
    ].join(' '),
  },
  credentials: {
    admin: {
      username: 'admin',
      password: 'admin-pass',
    },
  },
});
