/**
 * One comment per pull request, kept current: the reporter looks for the
 * comment the token's own account wrote whose first line is its marker and
 * edits it, and creates one only when none exists. The REST calls are the ones GitHub documents: read the token's
 * account, list the issue's comments, update a comment, create a comment.
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
const USER_AGENT = '@e2e-dev/github';
/** What GitHub answers `GET /user` with for an installation token: `GITHUB_TOKEN` or a GitHub App's. */
const INTEGRATION_REFUSAL = 'Resource not accessible by integration';

type Method = 'GET' | 'POST' | 'PATCH';

/** Sends one GitHub REST call and hands back the response as it came. */
function send(params: PostParams, method: Method, route: string, body?: unknown): Promise<Response> {
  return params.fetch(`${params.apiUrl}${route}`, {
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
}

/** The error for a response the protocol has no meaning for, with the start of its body. */
async function unexpected(response: Response, method: Method, route: string): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 200);
  return new Error(`GitHub responded ${response.status} to ${method} ${route}${detail === '' ? '' : `: ${detail}`}`);
}

/** The error the runner prints for a response that is not a success. */
async function failure(params: PostParams, response: Response, method: Method, route: string): Promise<Error> {
  if (response.status === 401) return new Error('GitHub rejected the token (GITHUB_TOKEN or GH_TOKEN)');
  if (response.status === 403 || response.status === 404) {
    return new Error(
      `the token cannot comment on ${params.repository}#${params.pullRequest}: a pull request from a fork runs with a read-only token, and the job needs \`permissions: pull-requests: write\``,
    );
  }
  return unexpected(response, method, route);
}

/** One GitHub REST call; anything but success is an error the runner can print. */
async function request(params: PostParams, method: Method, route: string, body?: unknown): Promise<unknown> {
  const response = await send(params, method, route, body);
  if (response.ok) return response.json().catch(() => undefined);
  throw await failure(params, response, method, route);
}

/** Whether a comment's author is the account the token posts as. */
type Author = (user: Record<string, unknown>) => boolean;

/**
 * The account the token posts as. A personal token names its user at
 * `GET /user`. An installation token cannot read it, and posts as its app's
 * bot, `github-actions[bot]` or `<app>[bot]`, so any bot author matches.
 */
async function tokenAuthor(params: PostParams): Promise<Author> {
  const response = await send(params, 'GET', '/user');
  if (response.ok) {
    const user: unknown = await response.json().catch(() => undefined);
    if (!isRecord(user) || typeof user['login'] !== 'string') throw new Error('GitHub answered GET /user without a login');
    const login = user['login'].toLowerCase();
    return (author) => typeof author['login'] === 'string' && author['login'].toLowerCase() === login;
  }
  if (response.status === 403) {
    const refusal: unknown = await response.clone().json().catch(() => undefined);
    if (isRecord(refusal) && refusal['message'] === INTEGRATION_REFUSAL) return (author) => author['type'] === 'Bot';
  }
  if (response.status === 401) throw await failure(params, response, 'GET', '/user');
  throw await unexpected(response, 'GET', '/user');
}

/**
 * Whether a comment body is the reporter's own for this marker: its first
 * line is the marker, exactly. The reporter has always written it there, so
 * a marker quoted further down, as in a reply, is not a match, and neither
 * is a first line that only starts or ends with it.
 */
function carriesMarker(body: string, marker: string): boolean {
  const end = body.indexOf('\n');
  const firstLine = end === -1 ? body : body.slice(0, end);
  return firstLine.replace(/\r$/, '') === marker;
}

/** The id of the comment the author wrote carrying the marker, or undefined when no page has one. */
async function findComment(params: PostParams, issue: string, author: Author): Promise<number | undefined> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const comments = await request(params, 'GET', `${issue}/comments?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('GitHub answered the comment list with a body that is not a list');
    const found = comments.find(
      (comment: unknown) =>
        isRecord(comment) &&
        isRecord(comment['user']) &&
        author(comment['user']) &&
        typeof comment['body'] === 'string' &&
        carriesMarker(comment['body'], params.marker),
    );
    if (isRecord(found) && typeof found['id'] === 'number') return found['id'];
    if (comments.length < PER_PAGE) return undefined;
  }
  return undefined;
}

/** Creates or updates the reporter's comment and resolves with its URL. */
export async function upsertComment(params: PostParams): Promise<string> {
  const issue = `/repos/${params.repository}/issues/${params.pullRequest}`;
  const existing = await findComment(params, issue, await tokenAuthor(params));
  const created =
    existing === undefined
      ? await request(params, 'POST', `${issue}/comments`, { body: params.body })
      : await request(params, 'PATCH', `/repos/${params.repository}/issues/comments/${existing}`, { body: params.body });
  if (!isRecord(created) || typeof created['html_url'] !== 'string') {
    throw new Error('GitHub answered the comment without its html_url');
  }
  return created['html_url'];
}
