/**
 * `@e2e-dev/github` public surface: the `github()` reporter factory. The
 * reporter posts one pull request comment per run from GitHub Actions,
 * through the `reporters` seam of `e2e`, and writes the same text to
 * the job summary. The page itself is `renderMarkdownReport` from `e2e`.
 */

export { github } from './reporter.ts';
export type { GitHubOptions } from './reporter.ts';
