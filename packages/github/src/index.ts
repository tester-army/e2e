/**
 * `@e2edev/github` public surface: the `github()` reporter factory and the
 * comment builder it uses. The reporter posts one pull request comment per
 * run from GitHub Actions, through the `reporters` seam of `@e2edev/e2e`,
 * and writes the same text to the job summary.
 */

export { github } from './reporter.ts';
export type { GitHubOptions } from './reporter.ts';
export { renderComment } from './comment.ts';
export type { CommentOptions } from './comment.ts';
