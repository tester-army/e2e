import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GRACE_MS,
  STALE_LABEL,
  graceExpired,
  isCommunity,
  isStale,
  monthBefore,
  problems,
  section,
  type Author,
  type OpenPullRequest,
} from './rules.ts';

const template = `<!--
Title: Conventional Commits.
-->

## What and why

-

## Issue

<!-- Fixes #123. Required for fix, chore, test, perf, ci, build, and revert PRs. -->

## Verified

Ran it locally: yes | no - <why>

-

## Checklist

- [ ] Changeset added.
`;

const filled = `## What and why

- Keeps the cursor after a reload.

## Issue

Fixes #42

## Verified

Ran it locally: yes

- \`pnpm test\` passes.
`;

const community: Author = { login: 'someone', association: 'CONTRIBUTOR', bot: false, fromFork: true };

test('a filled template on a fix passes', () => {
  assert.deepEqual(problems({ title: 'fix(web): keep the cursor', body: filled, closingIssues: 0 }), []);
});

test('the untouched template fails every section', () => {
  const found = problems({ title: 'fix: something', body: template, closingIssues: 0 });
  assert.equal(found.length, 3);
  assert.match(found[0] ?? '', /needs an existing issue/);
  assert.match(found[1] ?? '', /description is empty/);
  assert.match(found[2] ?? '', /Verified/);
});

test('a bad title is the only problem reported', () => {
  const found = problems({ title: 'Fix the cursor', body: template, closingIssues: 0 });
  assert.equal(found.length, 1);
  assert.match(found[0] ?? '', /Conventional Commit/);
});

test('feat, docs, and refactor need no issue', () => {
  const body = filled.replace('Fixes #42', '');
  for (const title of ['feat(cli)!: add a flag', 'docs: fix a link', 'refactor: split a file']) {
    assert.deepEqual(problems({ title, body, closingIssues: 0 }), [], title);
  }
  assert.equal(problems({ title: 'chore(deps): bump', body, closingIssues: 0 }).length, 1);
});

test('a closing keyword GitHub resolved counts as the issue', () => {
  const body = filled.replace('Fixes #42', '');
  assert.deepEqual(problems({ title: 'fix: x', body, closingIssues: 1 }), []);
});

test('an issue URL under ## Issue counts, a PR URL does not', () => {
  const issue = filled.replace('Fixes #42', 'https://github.com/tester-army/e2e/issues/42');
  const pull = filled.replace('Fixes #42', 'https://github.com/tester-army/e2e/pull/42');
  assert.deepEqual(problems({ title: 'fix: x', body: issue, closingIssues: 0 }), []);
  assert.equal(problems({ title: 'fix: x', body: pull, closingIssues: 0 }).length, 1);
});

test('a description without the template heading counts', () => {
  const body = '- Keeps the cursor after a reload.\n\n## Issue\n\nFixes #42\n\n## Verified\n\nRan it locally: yes\n';
  assert.deepEqual(problems({ title: 'fix: x', body, closingIssues: 0 }), []);
  assert.equal(problems({ title: 'fix: x', body: body.replace('- Keeps the cursor after a reload.', ''), closingIssues: 0 }).length, 1);
});

test('an unclosed HTML comment hides the rest of the body', () => {
  assert.equal(section('## Verified\n\nyes <!-- note\n## Issue\n#1', 'Verified'), 'yes');
  assert.equal(section('## Verified\n\na <!-- x --> b', 'Verified'), 'a  b');
});

test('section stops at the next heading and drops comments', () => {
  assert.equal(section(template, 'Issue'), '');
  assert.equal(section(filled, 'what and why'), '- Keeps the cursor after a reload.');
  assert.equal(section(filled, 'Missing'), undefined);
});

test('maintainers, bots, and branches in the repo are not community', () => {
  assert.equal(isCommunity(community), true);
  assert.equal(isCommunity({ ...community, association: 'MEMBER' }), false);
  assert.equal(isCommunity({ ...community, bot: true }), false);
  assert.equal(isCommunity({ ...community, fromFork: false }), false);
});

test('the grace period is 72 hours from the flag', () => {
  const flagged = '2026-10-23T00:00:00Z';
  const at = Date.parse(flagged);
  assert.equal(graceExpired(flagged, at + GRACE_MS - 1), false);
  assert.equal(graceExpired(flagged, at + GRACE_MS), true);
});

test('monthBefore clamps to the shorter month', () => {
  assert.equal(monthBefore(new Date('2026-03-31T12:00:00Z')).toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(monthBefore(new Date('2026-10-22T00:00:00Z')).toISOString(), '2026-09-22T00:00:00.000Z');
});

test('a month-old community PR with under 2 positive reactions is stale', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const old: OpenPullRequest = {
    createdAt: '2026-09-01T00:00:00Z',
    author: community,
    labels: [],
    reactions: [
      { content: 'THUMBS_UP', count: 1 },
      { content: 'EYES', count: 5 },
    ],
    approved: false,
  };
  assert.equal(isStale(old, now), true);
  assert.equal(isStale({ ...old, reactions: [...old.reactions, { content: 'ROCKET', count: 1 }] }, now), false);
  assert.equal(isStale({ ...old, createdAt: '2026-10-01T00:00:00Z' }, now), false);
  assert.equal(isStale({ ...old, approved: true }, now), false);
  assert.equal(isStale({ ...old, labels: [STALE_LABEL] }, now), false);
  assert.equal(isStale({ ...old, author: { ...community, association: 'OWNER' } }, now), false);
});
