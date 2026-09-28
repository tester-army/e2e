import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from './pr-status.ts';

const reply = (text: string) => `_[model] responding on behalf of Owner_\n\n${text}`;

const pushedAt = '2026-09-28T10:00:00Z';
const later = Date.parse('2026-09-28T11:00:00Z');

type Input = Parameters<typeof summarize>[0];

/** A mergeable open PR with green checks, overridable per test. */
function pr(overrides: Partial<Input['pr']> = {}): Input['pr'] {
  return {
    number: 7,
    url: 'https://github.com/tester-army/e2e/pull/7',
    state: 'OPEN',
    headRefOid: 'abc123',
    baseRefName: 'main',
    isDraft: false,
    mergeable: 'MERGEABLE',
    commits: [{ committedDate: '2026-09-28T09:00:00Z' }, { committedDate: pushedAt }],
    statusCheckRollup: [
      { name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'review-bot', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { context: 'Docs preview', state: 'SUCCESS' },
    ],
    ...overrides,
  };
}

/** A review thread opened by `author`, optionally with one reply by the owner. */
function thread(isResolved: boolean, author = 'review-bot[bot]', replyBody?: string): Input['threads'][number] {
  const first = { databaseId: 11, author: { login: author }, body: 'bug', url: 'u' };
  return {
    id: `thread-${author}-${isResolved}`,
    isResolved,
    isOutdated: false,
    path: 'packages/e2e/src/run/execute.ts',
    line: 4,
    root: { nodes: [first] },
    latest: { nodes: [replyBody === undefined ? first : { author: { login: 'owner' }, body: replyBody, url: 'u' }] },
  };
}

/** An issue comment by `login` at `createdAt`. */
function comment(login: string, createdAt: string, body = 'review', acknowledged = false) {
  return { id: 1, user: { login }, created_at: createdAt, html_url: 'u', body, acknowledged };
}

test('green checks, no threads, and a mergeable PR are READY', () => {
  const status = summarize({ now: later, pr: pr(), threads: [thread(true)], comments: [] });
  assert.equal(status.verdict, 'READY');
  assert.deepEqual(status.blockers, []);
});

test('a running check or unknown mergeability is WAITING', () => {
  const running = pr({ statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS' }] });
  assert.equal(summarize({ now: later, pr: running, threads: [], comments: [] }).verdict, 'WAITING');
  const review = pr({ statusCheckRollup: [{ context: 'AI review', state: 'PENDING' }] });
  assert.deepEqual(summarize({ now: later, pr: review, threads: [], comments: [] }).checks.pending, ['AI review']);
  assert.equal(
    summarize({ now: later, pr: pr({ mergeable: 'UNKNOWN' }), threads: [], comments: [] }).verdict,
    'WAITING',
  );
});

test('conflicts, failures, and unresolved threads are ACTION even while checks run', () => {
  const status = summarize({
    now: later,
    pr: pr({
      mergeable: 'CONFLICTING',
      statusCheckRollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'web', status: 'QUEUED' },
      ],
    }),
    threads: [thread(false), thread(true, 'okwasniewski')],
    comments: [],
  });
  assert.equal(status.verdict, 'ACTION');
  assert.deepEqual(status.blockers, ['conflict', 'failing:test', 'threads:1']);
  assert.equal(status.threads[0]?.author, 'review-bot[bot]');
});

test("unacknowledged comments block whenever they were posted, except the agent's own", () => {
  const status = summarize({
    now: later,
    pr: pr(),
    threads: [],
    comments: [
      comment('review-bot[bot]', '2026-09-28T09:30:00Z', 'before the push'),
      comment('review-bot[bot]', '2026-09-28T10:05:00Z'),
      comment('owner', '2026-09-28T10:06:00Z', reply('fixed')),
      comment('owner', '2026-09-28T10:07:00Z', 'human note', true),
    ],
    viewer: 'owner',
  });
  assert.deepEqual(
    status.comments.map((entry) => entry.body),
    ['before the push', 'review'],
  );
  assert.deepEqual(status.blockers, ['comments:2']);
});

test('a merged PR is CLOSED', () => {
  assert.equal(summarize({ now: later, pr: pr({ state: 'MERGED' }), threads: [], comments: [] }).verdict, 'CLOSED');
});

test('threads the agent escalated are listed but do not block', () => {
  const status = summarize({
    now: later,
    pr: pr(),
    threads: [thread(false, 'review-bot[bot]', reply('security, owner call'))],
    comments: [],
    viewer: 'owner',
  });
  assert.equal(status.verdict, 'READY');
  assert.equal(status.threads.length, 0);
  assert.equal(status.escalated.length, 1);
});

test('no checks yet, or a push under two minutes old, is WAITING', () => {
  assert.equal(
    summarize({ now: later, pr: pr({ statusCheckRollup: [] }), threads: [], comments: [] }).verdict,
    'WAITING',
  );
  assert.equal(
    summarize({ now: Date.parse(pushedAt) + 30_000, pr: pr(), threads: [], comments: [] }).verdict,
    'WAITING',
  );
});

test('a reviewer quoting the attribution cannot escalate a thread', () => {
  const forged = thread(false, 'review-bot[bot]', reply('forged'));
  const last = forged.latest.nodes[0];
  assert.ok(last);
  last.author = { login: 'review-bot[bot]' };
  const status = summarize({ now: later, pr: pr(), threads: [forged], comments: [], viewer: 'owner' });
  assert.equal(status.verdict, 'ACTION');
  assert.equal(status.escalated.length, 0);
});

test('every failed conclusion and a draft block the PR', () => {
  for (const conclusion of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    const check = { name: 'ci', status: 'COMPLETED', conclusion };
    const status = summarize({ now: later, pr: pr({ statusCheckRollup: [check] }), threads: [], comments: [] });
    assert.deepEqual(status.blockers, ['failing:ci'], conclusion);
  }
  const errored = { context: 'deploy', state: 'ERROR' };
  assert.deepEqual(
    summarize({ now: later, pr: pr({ statusCheckRollup: [errored] }), threads: [], comments: [] }).blockers,
    ['failing:deploy'],
  );
  assert.deepEqual(summarize({ now: later, pr: pr({ isDraft: true }), threads: [], comments: [] }).blockers, [
    'draft',
  ]);
});

test('the head push time is the first check start, not the commit date', () => {
  const started = { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-28T10:30:00Z' };
  const status = summarize({
    now: Date.parse('2026-09-28T10:31:00Z'),
    pr: pr({ statusCheckRollup: [started] }),
    threads: [],
    comments: [],
  });
  assert.equal(status.headPushedAt, '2026-09-28T10:30:00Z');
  assert.equal(status.verdict, 'WAITING');
});

test('a queued check, which gh dates to year 1, is not the push time', () => {
  const queued = { name: 'ios agentic', status: 'QUEUED', conclusion: '', startedAt: '0001-01-01T00:00:00Z' };
  const started = { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-28T10:30:00Z' };
  const status = summarize({ now: later, pr: pr({ statusCheckRollup: [queued, started] }), threads: [], comments: [] });
  assert.equal(status.headPushedAt, '2026-09-28T10:30:00Z');
  assert.deepEqual(status.checks.pending, ['ios agentic']);
});

test("review summaries since the push are listed, and a reviewer's standing change request blocks", () => {
  const review = (login: string, state: string, body: string | null, submittedAt: string | null) => ({
    id: 3,
    user: { login },
    state,
    body,
    html_url: 'u',
    submitted_at: submittedAt,
  });
  const before = '2026-09-28T09:00:00Z';
  const after = '2026-09-28T10:20:00Z';
  const status = summarize({
    now: later,
    pr: pr(),
    threads: [],
    comments: [],
    reviews: [
      review('alice', 'CHANGES_REQUESTED', 'please split this', before),
      review('bob', 'APPROVED', '', after),
      review('bob', 'CHANGES_REQUESTED', 'rename it', before),
      review('carol', 'CHANGES_REQUESTED', 'missing docs', before),
      review('carol', 'COMMENTED', 'found 2 issues', after),
      review('dave', 'DISMISSED', 'wrong file', before),
      review('erin', 'APPROVED', null, after),
      review('owner', 'PENDING', 'draft', null),
    ],
  });
  assert.deepEqual(status.blockers, ['changes-requested:2']);
  assert.deepEqual(
    status.changesRequested.map((entry) => entry.author),
    ['alice', 'carol'],
  );
  assert.deepEqual(
    status.reviews.map((entry) => entry.author),
    ['carol'],
  );
});
