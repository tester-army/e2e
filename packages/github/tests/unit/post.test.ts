/** The comment protocol against a fake GitHub: find by marker, edit or create, and fail with one message. */

import { describe, expect, it } from 'vitest';
import { upsertComment } from '../../src/post.ts';
import { fakeGitHub, json } from './fake-github.ts';

const MARKER = '<!-- e2e-github project=x -->';
const params = (fetchImpl: typeof fetch, signal = new AbortController().signal) => ({
  fetch: fetchImpl,
  signal,
  apiUrl: 'https://api.github.com',
  token: 'ghs_token',
  repository: 'octo/app',
  pullRequest: 41,
  marker: MARKER,
  body: `${MARKER}\n### e2e`,
});
const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: from + index, body: `comment ${from + index}` }));

describe('upsertComment', () => {
  it('creates a comment when none carries the marker, with the GitHub headers and the signal', async () => {
    const { fetch, calls } = fakeGitHub({
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
      'user-agent': '@e2e-dev/github',
    });
    expect(calls[1]?.headers['content-type']).toBe('application/json');
    expect(calls[1]?.body).toEqual({ body: `${MARKER}\n### e2e` });
  });

  it('edits the comment that carries the marker, searching past the first page', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /repos/octo/app/issues/41/comments?per_page=100&page=1': () => json(200, page(0, 100)),
      'GET /repos/octo/app/issues/41/comments?per_page=100&page=2': () => json(200, [{ id: 500, body: `${MARKER}\nold` }]),
      'PATCH /repos/octo/app/issues/comments/500': () => json(200, { id: 500, html_url: 'https://github.com/octo/app/pull/41#issuecomment-500' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-500');
    expect(calls.at(-1)?.method).toBe('PATCH');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('stops searching after a hundred full pages and posts a new comment', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET *': (call) => json(200, page(Number(new URL(call.url).searchParams.get('page')) * 100, 100)),
      'POST *': () => json(201, { id: 9, html_url: 'https://github.com/octo/app/pull/41#issuecomment-9' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-9');
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(100);
  });

  it('explains a token that cannot write, a rejected token, and anything else GitHub answers', async () => {
    const forbidden = fakeGitHub({ 'GET *': () => json(403, { message: 'Resource not accessible by integration' }) });
    await expect(upsertComment(params(forbidden.fetch))).rejects.toThrow(
      'the token cannot comment on octo/app#41: a pull request from a fork runs with a read-only token, and the job needs `permissions: pull-requests: write`',
    );
    const unauthorized = fakeGitHub({ 'GET *': () => json(401, { message: 'Bad credentials' }) });
    await expect(upsertComment(params(unauthorized.fetch))).rejects.toThrow('GitHub rejected the token (GITHUB_TOKEN or GH_TOKEN)');
    const broken = fakeGitHub({ 'GET *': () => new Response('upstream sad', { status: 502 }) });
    await expect(upsertComment(params(broken.fetch))).rejects.toThrow(
      'GitHub responded 502 to GET /repos/octo/app/issues/41/comments?per_page=100&page=1: upstream sad',
    );
    const notAList = fakeGitHub({ 'GET *': () => json(200, { message: 'odd' }) });
    await expect(upsertComment(params(notAList.fetch))).rejects.toThrow('GitHub answered the comment list with a body that is not a list');
    const noUrl = fakeGitHub({ 'GET *': () => json(200, []), 'POST *': () => json(201, { id: 3 }) });
    await expect(upsertComment(params(noUrl.fetch))).rejects.toThrow('GitHub answered the comment without its html_url');
  });

  it('carries the signal on every request and stops at once when it is aborted', async () => {
    const { fetch, calls } = fakeGitHub({ 'GET *': () => json(200, []) });
    const controller = new AbortController();
    controller.abort(new Error('budget spent'));
    await expect(upsertComment(params(fetch, controller.signal))).rejects.toThrow('budget spent');
    expect(calls).toHaveLength(1);
  });
});
