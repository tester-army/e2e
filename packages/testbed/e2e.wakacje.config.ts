import { defineConfig } from 'e2e';

/**
 * Opt-in agentic suite against wakacje.pl, a large production travel site with
 * heavy pages, cookie consent, autosuggest search, and a multi-step booking
 * funnel. Run manually:
 *
 *   E2E_MODEL_API_KEY=... pnpm --filter @e2edev/testbed test:wakacje
 *
 * Not part of CI: the site changes, rate-limits, and every step spends real
 * model calls. Tests navigate the funnel but never submit a reservation.
 *
 * Two suites cover the same journey on purpose. `wakacje.e2e.ts` spells out
 * every interaction as a located action; `wakacje-act.e2e.ts` names six outcomes
 * and lets `agent.act` plan the path. Running both is how we compare what the
 * planning tier costs and what it buys — 27 steps against 9, at more model calls
 * per step and less to read when one fails.
 */
export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-wakacje',
  app: {
    url: 'https://www.wakacje.pl',
    environment: 'production',
    allowProduction: true,
    allowedOrigins: ['https://www.wakacje.pl', 'https://wakacje.pl'],
  },
  tests: 'tests-wakacje/**/*.e2e.ts',
  targets: [{ name: 'web', platform: 'web', browser: 'chromium' }],
  // Every located action includes a model round trip (~3-8 s), so the
  // deterministic 30 s action budget is tight for a loaded provider. Latency
  // is not a product defect: give it room rather than reading it as failure.
  // The agentic suite runs six planning flows in one test, each of which is many
  // observations and model calls. Every agent deadline is additionally capped by
  // whatever remains of this, so it has to cover the whole journey.
  timeout: 900_000,
  actionTimeout: 60_000,
  // Agentic steps are comparable, not identical, run to run: a model that took a
  // wrong turn on a heavy page will often take the right one from clean state.
  // Retries bypass every agent cache, so the second attempt is a genuine retry
  // rather than a replay of the first one's route.
  retries: 1,
  agent: {
    // One model for every tier, and the one that was already trusted with this
    // suite's hardest calls. The split it replaces kept tree-only calls on a
    // cheap fast model and paid for the stronger one only where pixels were
    // involved; that saves money and makes a failure ambiguous, because the
    // planning rounds and the vision rounds of one journey were not answered by
    // the same reader. This funnel is the thing under test, so it is worth more
    // to know the flow failed than to know it failed cheaply.
    //
    // Override with E2E_MODEL. E2E_VISION_MODEL still splits the vision tier
    // back out, which is how the two are compared.
    model: process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ...(process.env.E2E_VISION_MODEL === undefined
      ? {}
      : { visionModel: process.env.E2E_VISION_MODEL }),
    // There is no project-wide `vision` default on purpose: it is opted into per
    // step, where the test can say why the tree is not enough. The suite does
    // pass fully vision-driven (`vision: true` here, `'only'` on the judgments)
    // if you want to measure that — ~65s against ~114s tree-driven, measured
    // under the earlier two-model split — but most steps here are answered well
    // by the tree.
    //
    // Commercial pages carry a huge SEO footer after the content, and this one
    // is over budget either way: the reservation dialog alone pushes it past
    // 32 KiB. What that costs is bounded now that the runner drops what is
    // scrolled out of view before what is on screen, rather than cutting in
    // document order — which used to drop the dialog, because a dialog is
    // appended last. Raising this further mostly buys more SEO footer.
    maxObservationBytes: 32_768,
    context: [
      'This is wakacje.pl, a Polish vacation booking site; the UI is in Polish.',
      'Common labels: "Dokąd chcesz jechać?" (destination), "Szukaj" (search),',
      '"Sprawdź" (check), "Rezerwuj" (book), "Akceptuję" (accept cookies).',
      'Prefer the control whose accessible name matches the request; offers are',
      'cards with a hotel name, rating, and a price in PLN (zł).',
    ].join(' '),
  },
});
