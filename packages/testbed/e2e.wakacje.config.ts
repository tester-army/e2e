import { defineConfig } from 'e2e';

/**
 * Opt-in agentic suite against wakacje.pl, a large production travel site with
 * heavy pages, cookie consent, autosuggest search, and a multi-step booking
 * funnel. Run manually:
 *
 *   E2E_MODEL_API_KEY=... pnpm --filter @e2e/testbed test:wakacje
 *
 * Not part of CI: the site changes, rate-limits, and every step spends real
 * model calls. Tests navigate the funnel but never submit a reservation.
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
  timeout: 300_000,
  actionTimeout: 60_000,
  agent: {
    // gemini-3.6-flash measures ~2x faster wall-clock than gemini-3-flash
    // here (~3.7s vs ~8.9s per call); override with E2E_MODEL to compare.
    model: process.env.E2E_MODEL ?? 'google/gemini-3.6-flash',
    // Reading a screenshot well is a much higher bar than accepting one: the
    // flash model above describes this page correctly and still misplaces what
    // it points at. The three steps that use pixels get the stronger model
    // without making every tree-only step pay for it. Override with
    // E2E_VISION_MODEL.
    visionModel: process.env.E2E_VISION_MODEL ?? 'openai/gpt-5.6-luna',
    // Images are billed by area, so the three steps that send pixels each cost
    // 700 tiles instead of 1196 at this viewport. 0.75 reads 11-20px text as
    // accurately as full scale; below ~0.6 small print starts failing.
    pixelScale: 0.75,
    // No project-wide default on purpose: `vision` is opted into per step, where
    // the test can say why the tree is not enough. The suite does pass fully
    // vision-driven (`vision: true` here, `'only'` on the judgments) if you want
    // to measure that — it was ~65s against ~114s tree-driven — but most steps
    // here are answered better and cheaper by the tree.
    // Commercial pages carry a huge SEO footer after the content. The budget
    // truncates the observation in DOM order, visibly to the model. 20 KiB is
    // too tight here: the destination modal's confirm button falls past the
    // cut. 32 KiB keeps every step's target in view.
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
