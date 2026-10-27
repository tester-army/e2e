import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { COMPLIANCE_LABEL, COMPLIANCE_MARKER, complianceComment } from './rules.ts';
import { addLabel, clear, closeWithComment, flag, graphql, livePullRequest, policyComment, type Comment } from './github.ts';

const TOKEN = 'test-token';

interface Call {
  url: URL;
  method: string;
  body: unknown;
}

type Reply = { status?: number; json?: unknown };

/** The call at `index`, failing the test when fewer calls landed. */
function nth(calls: Call[], index: number): Call {
  const call = calls[index];
  assert.ok(call !== undefined);
  return call;
}

/**
 * Answers every fetch from a table keyed by `METHOD path`, with a function
 * for the calls whose reply depends on the request. Collects the calls so a
 * test can assert what was sent and in which order.
 */
function stubFetch(respond: (call: Call) => Reply): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const reply = respond(call);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.json,
      text: async () => JSON.stringify(reply.json ?? {}),
    } as Response;
  });
  return calls;
}

const comment = (id: number, login: string, body: string): Comment => ({ id, body, created_at: '2026-10-01T00:00:00Z', user: { login } });

describe('pr-policy GitHub layer', () => {
  let originalToken: string | undefined;
  let originalRepository: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    originalRepository = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_TOKEN = TOKEN;
    process.env.GITHUB_REPOSITORY = 'tester-army/e2e';
  });

  afterEach(() => {
    mock.restoreAll();
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  });

  it('graphql posts to the repository with owner and name bound, and unwraps data', async () => {
    const calls = stubFetch(() => ({
      json: { data: { repository: { pullRequest: { title: 'x', body: 'y', closingIssuesReferences: { totalCount: 2 }, labels: { nodes: [{ name: 'l' }] } } } } },
    }));
    const data = await livePullRequest(7);
    const first = calls[0];
    assert.ok(first !== undefined);
    assert.equal(calls.length, 1);
    assert.equal(first.method, 'POST');
    assert.equal(first.url.pathname, '/graphql');
    assert.equal(first.url.hostname, 'api.github.com');
    const sent = first.body as { query: string; variables: Record<string, unknown> };
    assert.deepEqual(sent.variables, { owner: 'tester-army', name: 'e2e', number: 7 });
    assert.match(sent.query, /repository\(owner: \$owner, name: \$name\)/);
    assert.deepEqual(data, { title: 'x', body: 'y', closingIssues: 2, labels: ['l'] });
  });

  it('graphql joins the messages of a GraphQL error and refuses a response without data', async () => {
    stubFetch(() => ({ json: { errors: [{ message: 'bad' }, { message: 'worse' }] } }));
    await assert.rejects(graphql('query {}'), /bad; worse/);
    stubFetch(() => ({ json: {} }));
    await assert.rejects(graphql('query {}'), /without data/);
  });

  it('policyComment pages until a short page and finds only the bot marker comment', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => comment(index, 'someone', 'filler'));
    const calls = stubFetch((call) => ({
      json:
        call.url.searchParams.get('page') === '1'
          ? filler
          : [
              comment(201, 'github-actions[bot]', 'no marker here'),
              comment(202, 'someone', COMPLIANCE_MARKER),
              comment(200, 'github-actions[bot]', `Thanks for the PR.\n\n${COMPLIANCE_MARKER}\n\n- a problem`),
            ],
    }));
    const found = await policyComment(9);
    assert.equal(found?.id, 200);
    assert.equal(calls.length, 2);
    assert.match(nth(calls, 0).url.pathname, /\/issues\/9\/comments$/);
    assert.equal(nth(calls, 0).url.searchParams.get('per_page'), '100');
  });

  it('flag rewrites the comment in place on a labeled PR and adds no label', async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await flag(9, ['a problem'], true, comment(55, 'github-actions[bot]', 'old body'));
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url.pathname]),
      [['PATCH', '/repos/tester-army/e2e/issues/comments/55']],
    );
  });

  it('flag keeps an identical comment alone on a labeled PR', async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await flag(9, ['a problem'], true, comment(55, 'github-actions[bot]', complianceComment(['a problem'])));
    assert.equal(calls.length, 0);
  });

  it('flag deletes a stale comment, posts a new one, and labels an unlabeled PR', async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await flag(9, ['a problem'], false, comment(55, 'github-actions[bot]', 'stale text'));
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url.pathname]),
      [
        ['DELETE', '/repos/tester-army/e2e/issues/comments/55'],
        ['POST', '/repos/tester-army/e2e/issues/9/comments'],
        ['POST', '/repos/tester-army/e2e/issues/9/labels'],
      ],
    );
    assert.deepEqual(nth(calls, 2).body, { labels: [COMPLIANCE_LABEL] });
    const posted = String((nth(calls, 1).body as { body: string }).body);
    assert.match(posted, /a problem/);
    assert.ok(posted.includes(COMPLIANCE_MARKER));
  });

  it('clear drops the comment and the label, tolerating a label that is not there', async () => {
    const calls = stubFetch((call) =>
      call.url.pathname.endsWith(`/labels/${encodeURIComponent(COMPLIANCE_LABEL)}`) ? { status: 404, json: { message: 'Not Found' } } : { json: {} },
    );
    await clear(9, comment(55, 'github-actions[bot]', 'x'));
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url.pathname]),
      [
        ['DELETE', '/repos/tester-army/e2e/issues/comments/55'],
        ['DELETE', `/repos/tester-army/e2e/issues/9/labels/${encodeURIComponent(COMPLIANCE_LABEL)}`],
      ],
    );
  });

  it('clear still fails on an API error that is not a missing label', async () => {
    stubFetch(() => ({ status: 500, json: { message: 'boom' } }));
    await assert.rejects(clear(9, undefined), /500/);
  });

  it('closeWithComment comments first, then closes', async () => {
    const calls = stubFetch(() => ({ json: {} }));
    await closeWithComment(9, 'closing note');
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url.pathname]),
      [
        ['POST', '/repos/tester-army/e2e/issues/9/comments'],
        ['PATCH', '/repos/tester-army/e2e/pulls/9'],
      ],
    );
    assert.deepEqual(nth(calls, 1).body, { state: 'closed' });
  });

  it('addLabel posts the label under the issues path', async () => {
    const calls = stubFetch(() => ({ status: 204, json: undefined }));
    await addLabel(9, COMPLIANCE_LABEL);
    assert.deepEqual(calls, [{ url: nth(calls, 0).url, method: 'POST', body: { labels: [COMPLIANCE_LABEL] } }]);
    assert.equal(nth(calls, 0).url.pathname, '/repos/tester-army/e2e/issues/9/labels');
  });
});
