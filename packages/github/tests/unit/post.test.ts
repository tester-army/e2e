/** The comment protocol against a fake GitHub: find by marker, edit or create, and fail with one message. */

import { describe, expect, it } from 'vitest';
import { upsertComment } from '../../src/post.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeFetch(script: Record<string, (call: Call) => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const call: Call = { url, method, headers, body };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    const answer = script[key] ?? script[`${method} ${parsed.pathname}`] ?? script[`${method} *`];
    if (answer === undefined) throw new Error(`unexpected request ${key}`);
    return answer(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const MARKER = '<!-- e2e-github project=x -->';
const params = (fetchImpl: typeof fetch) => ({
  fetch: fetchImpl,
  signal: new AbortController().signal,
  apiUrl: 'https://api.github.com',
  token: 'ghs_token',
  repository: 'octo/app',
  pullRequest: 41,
  marker: MARKER,
  body: `${MARKER}\n### e2e`,
});

describe('upsertComment', () => {
  it('creates a comment when none carries the marker, with the GitHub headers', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /repos/octo/app/issues/41/comments': () => json(200, [{ id: 1, body: 'unrelated' }]),
      'POST /repos/octo/app/issues/41/comments': () => json(201, { id: 2, html_url: 'https://github.com/octo/app/pull/41#issuecomment-2' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-2');
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /repos/octo/app/issues/41/comments',
      'POST /repos/octo/app/issues/41/comments',
    ]);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer ghs_token',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': '@e2edev/github',
    });
    expect(calls[1]?.body).toEqual({ body: `${MARKER}\n### e2e` });
  });

  it('edits the comment that carries the marker, searching past the first page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index, body: `comment ${index}` }));
    const { fetch, calls } = fakeFetch({
      'GET /repos/octo/app/issues/41/comments?per_page=100&page=1': () => json(200, firstPage),
      'GET /repos/octo/app/issues/41/comments?per_page=100&page=2': () => json(200, [{ id: 500, body: `${MARKER}\nold` }]),
      'PATCH /repos/octo/app/issues/comments/500': () => json(200, { id: 500, html_url: 'https://github.com/octo/app/pull/41#issuecomment-500' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-500');
    expect(calls.at(-1)?.method).toBe('PATCH');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('explains a token that cannot write, a rejected token, and anything else GitHub answers', async () => {
    const forbidden = fakeFetch({ 'GET *': () => json(403, { message: 'Resource not accessible by integration' }) });
    await expect(upsertComment(params(forbidden.fetch))).rejects.toThrow(
      'the token cannot comment on octo/app#41: a pull request from a fork runs with a read-only token, and the job needs `permissions: pull-requests: write`',
    );
    const unauthorized = fakeFetch({ 'GET *': () => json(401, { message: 'Bad credentials' }) });
    await expect(upsertComment(params(unauthorized.fetch))).rejects.toThrow('GitHub rejected the token in GITHUB_TOKEN');
    const broken = fakeFetch({ 'GET *': () => new Response('upstream sad', { status: 502 }) });
    await expect(upsertComment(params(broken.fetch))).rejects.toThrow('GitHub responded 502 to GET /repos/octo/app/issues/41/comments?per_page=100&page=1: upstream sad');
    const odd = fakeFetch({
      'GET *': () => json(200, []),
      'POST *': () => json(201, { id: 3 }),
    });
    await expect(upsertComment(params(odd.fetch))).rejects.toThrow('GitHub answered the comment without its html_url');
  });

  it('stops at once when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch({ 'GET *': () => json(200, []) });
    const controller = new AbortController();
    controller.abort(new Error('budget spent'));
    await expect(upsertComment({ ...params(fetch), signal: controller.signal })).rejects.toThrow('budget spent');
    expect(calls).toHaveLength(1);
  });
});
