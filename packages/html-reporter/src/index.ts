/**
 * `@e2e-dev/html-reporter` public surface: the `htmlReporter()` factory. The
 * reporter writes one self-contained HTML page per run through the
 * `reporters` seam of `e2e`; the page itself is the app under `app/`, built
 * into a single file at package build time.
 */

export { htmlReporter } from './reporter.ts';
export type { HtmlReporterOptions } from './reporter.ts';
