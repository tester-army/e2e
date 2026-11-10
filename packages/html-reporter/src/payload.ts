/**
 * What the reporter hands the page, and how it rides inside it. The page is
 * one prebuilt HTML file with a placeholder JSON script; the reporter swaps
 * the run's data in, so the result opens from disk with no server and no
 * fetch. The app (`app/`) imports these types too, so both sides agree.
 */

import type { Report } from 'e2e';

/**
 * How the page reaches the run's screenshots, videos, and files:
 * - `link`: by relative path from the page, under `base` (a POSIX path,
 *   `results` when the page sits beside `.e2e/results/`).
 * - `embed`: from `files`, each artifact path's bytes as a `data:` URL, so
 *   the page is the whole report.
 * - `none`: not at all; the page shows text only.
 */
export type ReportMedia =
  | { readonly mode: 'link'; readonly base: string }
  | { readonly mode: 'embed'; readonly files: Readonly<Record<string, string>> }
  | { readonly mode: 'none' };

/** The data one report page renders. */
export interface ReportPayload {
  /** The run's report-1 document, unchanged. */
  readonly report: Report;
  readonly media: ReportMedia;
  /**
   * The run's results directory from the project root, a POSIX path
   * (`.e2e/results`). The page names files there in the prompt it copies for
   * a coding agent, which reads them from the project.
   */
  readonly resultsDir: string;
  /** Each kept `trace.md` by report result id, as a path from the project root. */
  readonly traces: Readonly<Record<string, string>>;
  /**
   * Lines of the project's test files around each step and error, by file
   * (as the report names it) then line number, for the page's code frames.
   */
  readonly sources: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The text the built page holds in place of the payload, until a reporter fills it. */
export const PAYLOAD_PLACEHOLDER = '"__E2E_REPORT_PAYLOAD__"';

/**
 * The page with the payload in place of the placeholder. `<` is escaped
 * inside the JSON so no value (a test title, an error message) can close the
 * script element or open a comment; `JSON.parse` reads `<` back as `<`.
 */
export function embedPayload(template: string, payload: ReportPayload): string {
  const [head, tail, ...rest] = template.split(PAYLOAD_PLACEHOLDER);
  if (head === undefined || tail === undefined || rest.length > 0) {
    throw new Error('the report page template must hold the payload placeholder exactly once');
  }
  return head + JSON.stringify(payload).replaceAll('<', '\\u003c') + tail;
}
