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
    // Unused while `vision` is on for the whole project, but kept as the
    // tree-only baseline: drop the default below and every step falls back to
    // this model. Override with E2E_MODEL.
    model: process.env.E2E_MODEL ?? 'google/gemini-3.6-flash',
    // This suite is deliberately vision-driven end to end: every model call
    // sees the page, because on a commercial site the tree and the screen
    // disagree constantly — overlays, promo images, sticky bars, cards whose
    // accessible name is the entire card. Reading a screenshot well is a much
    // higher bar than accepting one, so the whole run gets the stronger model.
    // Override with E2E_VISION_MODEL.
    visionModel: process.env.E2E_VISION_MODEL ?? 'openai/gpt-5.6-luna',
    // Project-wide default: the tree still travels with the pixels, which is
    // what keeps a tap on a real control resolving to a real node. Steps whose
    // question is purely about what the page presents opt down to 'only'.
    vision: true,
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
