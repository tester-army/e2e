/**
 * The comment body is the markdown page `@e2edev/e2e` renders for its own
 * `markdown` reporter, so the pull request, the job summary, `summary.md`,
 * and a hosted run page all read the same. The names here are the ones this
 * package has always exported.
 */

export { renderMarkdownReport as renderComment, MAX_MARKER_CHARS, MAX_URL_CHARS } from '@e2edev/e2e';
export type { MarkdownReportOptions as CommentOptions } from '@e2edev/e2e';
