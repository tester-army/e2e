/** What every fixture page is rendered from: the app's state and the request URL. */

/**
 * The state one fixture app keeps for its lifetime, the way an app with a
 * database shows the last run's data on the next run's first screen.
 */
export interface FixtureState {
  /** Searches made so far; the results page counts them. */
  searches: number;
  /** Feed requests so far; every one rotates the offers. */
  feedRequests: number;
  /** Todos added through `/api/todos`. */
  readonly todos: Set<string>;
}

/** Renders one page for one request. */
export type PageRenderer = (state: FixtureState, url: URL) => string;

/** A page that reads nothing from the request. */
export function constant(page: string): PageRenderer {
  return () => page;
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
