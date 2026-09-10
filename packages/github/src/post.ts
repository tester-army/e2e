/**
 * One comment per pull request, kept current: the reporter looks for the
 * comment carrying its marker and edits it, and creates one only when none
 * exists. The REST calls are the three GitHub documents them as: list the
 * issue's comments, update a comment, create a comment.
 *
 * Every request carries the reporter's abort signal. Anything GitHub answers
 * outside the protocol is an error naming itself; the runner prints one line.
 */

import { isRecord } from './json.ts';

export interface PostParams {
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  /** `https://api.github.com`, or an Enterprise Server API root. */
  readonly apiUrl: string;
  readonly token: string;
  /** `owner/repo`. */
  readonly repository: string;
  readonly pullRequest: number;
  /** The hidden HTML comment that identifies the reporter's own comment. */
  readonly marker: string;
  readonly body: string;
}

const PER_PAGE = 100;
/**
 * The list is followed until a short page says it is exhausted. The cap is a
 * guard against a server that never sends one, not a limit any pull request
 * reaches: ten thousand comments.
 */
const MAX_PAGES = 100;
const USER_AGENT = '@e2edev/github';

type Method = 'GET' | 'POST' | 'PATCH';

/** One GitHub REST call; anything but success is an error the runner can print. */
async function request(params: PostParams, method: Method, route: string, body?: unknown): Promise<unknown> {
  const response = await params.fetch(`${params.apiUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${params.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: params.signal,
  });
  if (response.ok) return response.json().catch(() => undefined);
  const detail = (await response.text().catch(() => '')).slice(0, 200);
  if (response.status === 401) throw new Error('GitHub rejected the token (GITHUB_TOKEN or GH_TOKEN)');
  if (response.status === 403 || response.status === 404) {
    throw new Error(
      `the token cannot comment on ${params.repository}#${params.pullRequest}: a pull request from a fork runs with a read-only token, and the job needs \`permissions: pull-requests: write\``,
    );
  }
  throw new Error(`GitHub responded ${response.status} to ${method} ${route}${detail === '' ? '' : `: ${detail}`}`);
}

/** The id of the comment carrying the marker, or undefined when no page has one. */
async function findComment(params: PostParams, issue: string): Promise<number | undefined> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const comments = await request(params, 'GET', `${issue}/comments?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('GitHub answered the comment list with a body that is not a list');
    const found = comments.find(
      (comment: unknown) =>
        isRecord(comment) && typeof comment['body'] === 'string' && comment['body'].includes(params.marker),
    );
    if (isRecord(found) && typeof found['id'] === 'number') return found['id'];
    if (comments.length < PER_PAGE) return undefined;
  }
  return undefined;
}

/** Creates or updates the reporter's comment and resolves with its URL. */
export async function upsertComment(params: PostParams): Promise<string> {
  const issue = `/repos/${params.repository}/issues/${params.pullRequest}`;
  const existing = await findComment(params, issue);
  const created =
    existing === undefined
      ? await request(params, 'POST', `${issue}/comments`, { body: params.body })
      : await request(params, 'PATCH', `/repos/${params.repository}/issues/comments/${existing}`, { body: params.body });
  if (!isRecord(created) || typeof created['html_url'] !== 'string') {
    throw new Error('GitHub answered the comment without its html_url');
  }
  return created['html_url'];
}
