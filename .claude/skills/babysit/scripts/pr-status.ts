#!/usr/bin/env node
/**
 * One JSON snapshot of what stands between a PR and human review: conflicts,
 * failing and pending checks, unresolved review threads, comments nobody
 * acknowledged, and standing change requests.
 *
 * Agent replies start with the babysit skill's attribution line and come from
 * the `gh` user; that marks the agent's own comments and the threads it
 * escalated to the human, which are listed but do not block. A comment is
 * acknowledged by a 👍 from the `gh` user, whenever it was posted. Review
 * summaries since the push are listed; a reviewer whose latest verdict is
 * changes-requested blocks until they approve, re-review, or are dismissed.
 *
 * Usage: `node .claude/skills/babysit/scripts/pr-status.ts [pr] [--watch] [--interval <s>] [--timeout <s>]`
 */

import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

type Verdict = 'READY' | 'WAITING' | 'ACTION' | 'CLOSED';

/** A CheckRun carries `status`; a legacy StatusContext carries only `state`. */
interface Check {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  startedAt?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
}

interface PullRequest {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  commits: { committedDate: string }[];
  statusCheckRollup?: Check[] | null;
}

interface ThreadComment {
  databaseId?: number;
  author: { login: string } | null;
  body: string;
  url: string;
}

interface Thread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  /** The finding that opened the thread, and the newest reply, however long the thread. */
  root: { nodes: ThreadComment[] };
  latest: { nodes: ThreadComment[] };
}

interface ThreadPage {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  nodes: Thread[];
}

/** GitHub nulls the author of a comment or review whose account was deleted. */
type Author = { login: string } | null;

interface IssueComment {
  id: number;
  user: Author;
  created_at: string;
  html_url: string;
  body: string;
  acknowledged?: boolean;
}

interface Review {
  id: number;
  user: Author;
  state: string;
  body: string | null;
  html_url: string;
  /** Null for the viewer's own unsubmitted draft. */
  submitted_at: string | null;
}

interface SummaryInput {
  pr: PullRequest;
  threads: Thread[];
  comments: IssueComment[];
  reviews?: Review[];
  viewer?: string;
  now?: number;
}

// STALE: GitHub expired a result nobody refreshed; it needs a rerun, not trust.
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR']);
const AGENT_REPLY = /^_\[[^\]]+\] responding on behalf of /;
// GitHub exposes no push time; the head's first check start is the closest
// signal, and the commit date (which can predate the push) the fallback.
const SETTLE_MS = 120_000;
// A review in one of these states replaces its author's earlier verdict; a
// plain comment review leaves it standing, as in GitHub's own review decision.
const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Reduces raw GitHub data to blockers, pending work, and a verdict: READY, WAITING, ACTION, or CLOSED. */
export function summarize({ pr, threads, comments, reviews = [], viewer, now = Date.now() }: SummaryInput) {
  const rollup = pr.statusCheckRollup ?? [];
  const failing: { name: string | undefined; link: string | null }[] = [];
  const pending: (string | undefined)[] = [];
  for (const check of rollup) {
    const name = check.name ?? check.context;
    const link = check.detailsUrl ?? check.targetUrl ?? null;
    const outcome = check.conclusion ?? check.state;
    if (check.status !== undefined && check.status !== 'COMPLETED') pending.push(name);
    else if (outcome === 'PENDING' || outcome === 'EXPECTED') pending.push(name);
    else if (outcome !== undefined && FAILED.has(outcome)) failing.push({ name, link });
  }
  if (rollup.length === 0) pending.push('checks not reported yet');
  // `gh` writes a check that has not started as 0001-01-01T00:00:00Z, not null.
  const checkStarts = rollup
    .map((check) => check.startedAt)
    .filter((startedAt): startedAt is string => typeof startedAt === 'string' && Date.parse(startedAt) > 0)
    .toSorted();
  const headPushedAt = checkStarts[0] ?? pr.commits.at(-1)?.committedDate ?? null;
  if (headPushedAt !== null && now - Date.parse(headPushedAt) < SETTLE_MS) {
    pending.push('checks settling after push');
  }
  const byAgent = (login: string | undefined, body: string) =>
    login !== undefined && login === viewer && AGENT_REPLY.test(body);
  const unresolved = threads
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const first = thread.root.nodes[0];
      const last = thread.latest.nodes[0];
      return {
        id: thread.id,
        commentId: first?.databaseId ?? null,
        author: first?.author?.login ?? null,
        lastAuthor: last?.author?.login ?? null,
        path: thread.path,
        line: thread.line,
        outdated: thread.isOutdated,
        escalated: last !== undefined && byAgent(last.author?.login, last.body),
        url: first?.url ?? null,
        body: (first?.body ?? '').slice(0, 600),
      };
    });
  const open = unresolved.filter((thread) => !thread.escalated);
  const unacknowledged = comments
    .filter((comment) => comment.acknowledged !== true && !byAgent(comment.user?.login, comment.body))
    .map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? null,
      url: comment.html_url,
      body: comment.body.slice(0, 600),
    }));
  const blockers: string[] = [];
  if (pr.mergeable === 'CONFLICTING') blockers.push('conflict');
  if (pr.isDraft) blockers.push('draft');
  if (failing.length > 0) blockers.push(`failing:${failing.map((check) => check.name).join(',')}`);
  if (open.length > 0) blockers.push(`threads:${open.length}`);
  if (unacknowledged.length > 0) blockers.push(`comments:${unacknowledged.length}`);
  const submitted = reviews.filter(
    (review): review is Review & { submitted_at: string } => review.submitted_at !== null,
  );
  const verdicts = new Map<string, Review>();
  for (const review of submitted.toSorted((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    if (VERDICTS.has(review.state)) verdicts.set(review.user?.login ?? `deleted:${review.id}`, review);
  }
  const changesRequested = [...verdicts.values()]
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .map((review) => ({ id: review.id, author: review.user?.login ?? null, url: review.html_url }));
  if (changesRequested.length > 0) blockers.push(`changes-requested:${changesRequested.length}`);
  const newReviews = submitted
    .filter((review) => headPushedAt === null || review.submitted_at > headPushedAt)
    .filter((review) => review.state === 'CHANGES_REQUESTED' || (review.body ?? '').trim() !== '')
    .map((review) => ({
      id: review.id,
      author: review.user?.login ?? null,
      state: review.state,
      url: review.html_url,
      body: (review.body ?? '').slice(0, 600),
    }));
  if (pr.mergeable === 'UNKNOWN') pending.push('mergeability');
  return {
    verdict: verdictOf(pr.state, blockers, pending),
    blockers,
    pr: pr.number,
    url: pr.url,
    head: pr.headRefOid,
    headPushedAt,
    base: pr.baseRefName,
    checks: { failing, pending },
    threads: open,
    escalated: unresolved.filter((thread) => thread.escalated),
    comments: unacknowledged,
    reviews: newReviews,
    changesRequested,
  };
}

/** True when `viewer` reacted 👍 among a comment's reactions; any other reaction or reactor does not count. */
export function acknowledges(reactions: { content: string; user: Author }[], viewer: string): boolean {
  return reactions.some((reaction) => reaction.content === '+1' && reaction.user?.login === viewer);
}

/** CLOSED for a merged or closed PR, else the most urgent open state. */
function verdictOf(state: string, blockers: string[], pending: unknown[]): Verdict {
  if (state !== 'OPEN') return 'CLOSED';
  if (blockers.length > 0) return 'ACTION';
  if (pending.length > 0) return 'WAITING';
  return 'READY';
}

/** Runs `gh` and returns its stdout. */
function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Reads the PR, its review threads, comments, and reviews, then summarizes them. */
function fetchStatus(selector: string | null) {
  const pr = JSON.parse(
    gh([
      'pr',
      'view',
      ...(selector === null ? [] : [selector]),
      '--json',
      'number,url,state,headRefOid,baseRefName,isDraft,mergeable,commits,statusCheckRollup',
    ]),
  ) as PullRequest;
  const [owner, repo] = new URL(pr.url).pathname.split('/').slice(1, 3);
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line root:comments(first:1){nodes{databaseId author{login} body url}} latest:comments(last:1){nodes{author{login} body}}}}}}}`;
  const threads: Thread[] = [];
  let after: string | null = null;
  do {
    const response = JSON.parse(
      gh([
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${pr.number}`,
        ...(after === null ? [] : ['-f', `after=${after}`]),
      ]),
    ) as { data: { repository: { pullRequest: { reviewThreads: ThreadPage } } } };
    const page = response.data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  const viewer = (JSON.parse(gh(['api', 'user'])) as { login: string }).login;
  const acknowledgedBy = (id: number) =>
    acknowledges(
      (
        JSON.parse(
          gh([
            'api',
            '--paginate',
            '--slurp',
            `repos/${owner}/${repo}/issues/comments/${id}/reactions?content=%2B1&per_page=100`,
          ]),
        ) as { content: string; user: Author }[][]
      ).flat(),
      viewer,
    );
  const comments = (
    JSON.parse(
      gh(['api', '--paginate', '--slurp', `repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`]),
    ) as (IssueComment & { reactions?: Record<string, number> })[][]
  )
    .flat()
    .map((comment) => ({
      ...comment,
      acknowledged: (comment.reactions?.['+1'] ?? 0) > 0 && acknowledgedBy(comment.id),
    }));
  const reviews = (
    JSON.parse(
      gh(['api', '--paginate', '--slurp', `repos/${owner}/${repo}/pulls/${pr.number}/reviews?per_page=100`]),
    ) as Review[][]
  ).flat();
  return summarize({ pr, threads, comments, reviews, viewer });
}

/** A positive number of seconds for `flag`, or an error naming it. */
function seconds(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} needs a positive number of seconds`);
  return parsed;
}

/** Parses `[pr] [--watch] [--interval <s>] [--timeout <s>]`. */
function parseArgs(argv: string[]) {
  const options = { selector: null as string | null, watch: false, interval: 60, timeout: 1800 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--watch') options.watch = true;
    else if (arg === '--interval') options.interval = seconds(arg, argv[++index]);
    else if (arg === '--timeout') options.timeout = seconds(arg, argv[++index]);
    else if (!arg.startsWith('--')) options.selector = arg;
    else throw new Error(`unknown flag ${arg}`);
  }
  return options;
}

/** Prints one snapshot, or with `--watch` polls until the verdict is no longer WAITING. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.timeout * 1000;
  let status = fetchStatus(options.selector);
  while (options.watch && status.verdict === 'WAITING' && Date.now() < deadline) {
    await delay(options.interval * 1000);
    status = fetchStatus(options.selector);
  }
  console.log(JSON.stringify(status, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
