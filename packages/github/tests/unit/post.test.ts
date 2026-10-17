/** The comment protocol against a fake GitHub: find by author and marker, edit or create, and fail with one message. */

import { describe, expect, it } from 'vitest';
import { upsertComment } from '../../src/post.ts';
import { fakeGitHub, json } from './fake-github.ts';

const MARKER = '<!-- e2e-github project=x -->';
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
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
const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: from + index, user: BOT, body: `comment ${from + index}` }));
const routes = (calls: readonly { method: string; url: string }[]) => calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);

describe('upsertComment', () => {
  it('creates a comment when none carries the marker, with the GitHub headers and the signal', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /repos/octo/app/issues/41/comments': () => json(200, [{ id: 1, body: 'unrelated' }]),
      'POST /repos/octo/app/issues/41/comments': () => json(201, { id: 2, html_url: 'https://github.com/octo/app/pull/41#issuecomment-2' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-2');
    expect(routes(calls)).toEqual(['GET /user', 'GET /repos/octo/app/issues/41/comments', 'POST /repos/octo/app/issues/41/comments']);
    expect(calls[1]?.headers).toMatchObject({
      authorization: 'Bearer ghs_token',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': '@e2e-dev/github',
    });
    expect(calls[2]?.headers['content-type']).toBe('application/json');
    expect(calls[2]?.body).toEqual({ body: `${MARKER}\n### e2e` });
  });

  it('edits the comment that carries the marker, searching past the first page', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /repos/octo/app/issues/41/comments?per_page=100&page=1': () => json(200, page(0, 100)),
      'GET /repos/octo/app/issues/41/comments?per_page=100&page=2': () => json(200, [{ id: 500, user: BOT, body: `${MARKER}\nold` }]),
      'PATCH /repos/octo/app/issues/comments/500': () => json(200, { id: 500, html_url: 'https://github.com/octo/app/pull/41#issuecomment-500' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-500');
    expect(calls.at(-1)?.method).toBe('PATCH');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('matches only a comment whose first line is the marker, not one that quotes it or extends it', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET *': () =>
        json(200, [
          { id: 1, user: BOT, body: `> ${MARKER}\n> quoted in a reply` },
          { id: 2, user: BOT, body: `### e2e\n${MARKER}` },
          { id: 3, user: BOT, body: `${MARKER.replace(' -->', ' key=a -->')}\nanother job` },
          { id: 4, user: BOT, body: `${MARKER} extra\nnot the marker line` },
          { id: 5, user: BOT, body: `${MARKER}\r\nedited on the web` },
        ]),
      'PATCH /repos/octo/app/issues/comments/5': () => json(200, { id: 5, html_url: 'https://github.com/octo/app/pull/41#issuecomment-5' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-5');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'PATCH']);
  });

  it('never edits a comment another account wrote with the marker, and posts its own', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /repos/octo/app/issues/41/comments': () =>
        json(200, [
          { id: 1, user: { login: 'mallory', type: 'User' }, body: `${MARKER}\n### e2e: 9 passed` },
          { id: 2, body: `${MARKER}\nno author` },
        ]),
      'POST /repos/octo/app/issues/41/comments': () => json(201, { id: 3, html_url: 'https://github.com/octo/app/pull/41#issuecomment-3' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-3');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it("edits a GitHub App's own comment with the app's installation token", async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /repos/octo/app/issues/41/comments': () =>
        json(200, [
          { id: 1, user: { login: 'mallory', type: 'User' }, body: `${MARKER}\nfirst` },
          { id: 2, user: { login: 'shop-ci[bot]', type: 'Bot' }, body: `${MARKER}\nfrom the app` },
        ]),
      'PATCH /repos/octo/app/issues/comments/2': () => json(200, { id: 2, html_url: 'https://github.com/octo/app/pull/41#issuecomment-2' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-2');
    expect(routes(calls)).toEqual(['GET /user', 'GET /repos/octo/app/issues/41/comments', 'PATCH /repos/octo/app/issues/comments/2']);
  });

  it('matches the account a personal token belongs to, as GET /user names it', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET /user': () => json(200, { login: 'Octo-CI' }),
      'GET /repos/octo/app/issues/41/comments': () =>
        json(200, [
          { id: 1, user: BOT, body: `${MARKER}\nfrom GITHUB_TOKEN` },
          { id: 2, user: { login: 'octo-ci', type: 'User' }, body: `${MARKER}\nfrom the personal token` },
        ]),
      'PATCH /repos/octo/app/issues/comments/2': () => json(200, { id: 2, html_url: 'https://github.com/octo/app/pull/41#issuecomment-2' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-2');
    expect(routes(calls)).toEqual(['GET /user', 'GET /repos/octo/app/issues/41/comments', 'PATCH /repos/octo/app/issues/comments/2']);
  });

  it('stops searching after a hundred full pages and posts a new comment', async () => {
    const { fetch, calls } = fakeGitHub({
      'GET *': (call) => json(200, page(Number(new URL(call.url).searchParams.get('page')) * 100, 100)),
      'POST *': () => json(201, { id: 9, html_url: 'https://github.com/octo/app/pull/41#issuecomment-9' }),
    });
    await expect(upsertComment(params(fetch))).resolves.toBe('https://github.com/octo/app/pull/41#issuecomment-9');
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(101);
  });

  it('explains a token that cannot write, a rejected token, and anything else GitHub answers', async () => {
    const forbidden = fakeGitHub({ 'GET *': () => json(403, { message: 'Resource not accessible by integration' }) });
    await expect(upsertComment(params(forbidden.fetch))).rejects.toThrow(
      'the token cannot comment on octo/app#41: a pull request from a fork runs with a read-only token, and the job needs `permissions: pull-requests: write`',
    );
    const unauthorized = fakeGitHub({ 'GET *': () => json(401, { message: 'Bad credentials' }), 'GET /user': () => json(401, {}) });
    await expect(upsertComment(params(unauthorized.fetch))).rejects.toThrow('GitHub rejected the token (GITHUB_TOKEN or GH_TOKEN)');
    const broken = fakeGitHub({ 'GET *': () => new Response('upstream sad', { status: 502 }) });
    await expect(upsertComment(params(broken.fetch))).rejects.toThrow(
      'GitHub responded 502 to GET /repos/octo/app/issues/41/comments?per_page=100&page=1: upstream sad',
    );
    const noLogin = fakeGitHub({ 'GET /user': () => json(200, { id: 1 }) });
    await expect(upsertComment(params(noLogin.fetch))).rejects.toThrow('GitHub answered GET /user without a login');
    const userDown = fakeGitHub({ 'GET /user': () => new Response('upstream sad', { status: 502 }) });
    await expect(upsertComment(params(userDown.fetch))).rejects.toThrow('GitHub responded 502 to GET /user: upstream sad');
    const limited = fakeGitHub({ 'GET /user': () => json(403, { message: 'API rate limit exceeded' }) });
    await expect(upsertComment(params(limited.fetch))).rejects.toThrow('GitHub responded 403 to GET /user: {"message":"API rate limit exceeded"}');
    const notAList = fakeGitHub({ 'GET *': () => json(200, { message: 'odd' }) });
    await expect(upsertComment(params(notAList.fetch))).rejects.toThrow('GitHub answered the comment list with a body that is not a list');
    const noUrl = fakeGitHub({ 'GET *': () => json(200, []), 'POST *': () => json(201, { id: 3 }) });
    await expect(upsertComment(params(noUrl.fetch))).rejects.toThrow('GitHub answered the comment without its html_url');
  });

  it('reports throttling, not token permissions, for a rate-limited request', async () => {
    const throttled = [
      { status: 403, headers: { 'x-ratelimit-remaining': '0' }, message: 'API rate limit exceeded' },
      { status: 403, headers: { 'retry-after': '60' }, message: 'slow down' },
      { status: 403, headers: {}, message: 'You have exceeded a secondary rate limit' },
      { status: 429, headers: {}, message: 'too many requests' },
    ];
    for (const { status, headers, message } of throttled) {
      const { fetch, calls } = fakeGitHub({
        'GET *': () => new Response(JSON.stringify({ message }), { status, headers }),
      });
      await expect(upsertComment(params(fetch))).rejects.toThrow(
        'GitHub rate limited GET /repos/octo/app/issues/41/comments?per_page=100&page=1; wait for the rate-limit reset or Retry-After before rerunning the job',
      );
      expect(routes(calls)).toEqual(['GET /user', 'GET /repos/octo/app/issues/41/comments']);
    }
  });

  it('carries the signal on every request and stops at once when it is aborted', async () => {
    const { fetch, calls } = fakeGitHub({ 'GET *': () => json(200, []) });
    const controller = new AbortController();
    controller.abort(new Error('budget spent'));
    await expect(upsertComment(params(fetch, controller.signal))).rejects.toThrow('budget spent');
    expect(calls).toHaveLength(1);
  });
});
