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
    // Steps with `vision: true` judge pixels instead of the tree, and reading a
    // screenshot well is a much higher bar than accepting one: a flash model
    // describes this page correctly and still misplaces what it points at. The
    // visual steps get a stronger model without making every fast text-only
    // step pay for it. Override with E2E_VISION_MODEL.
    visionModel: process.env.E2E_VISION_MODEL ?? 'openai/gpt-5.4',
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
