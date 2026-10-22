/**
 * Daily close of community pull requests (`.github/workflows/pr-policy-sweep.yml`):
 *
 * - flagged by `check.ts` and still failing, on its live title and body, 72
 *   hours after the check's comment;
 * - open for more than a month with fewer than 2 positive reactions, unless a
 *   maintainer approved it or it was reopened after an earlier sweep.
 *
 * `--dry-run` lists what it would close. `--max-close <n>` caps the closes
 * per run (default 20).
 */

import { addLabel, clear, closeWithComment, flag, graphql, livePullRequest, policyComment } from './github.ts';
import {
  COMPLIANCE_CLOSE_MESSAGE,
  COMPLIANCE_LABEL,
  STALE_CLOSE_MESSAGE,
  STALE_LABEL,
  graceExpired,
  isCommunity,
  isMaintainer,
  isStale,
  positiveReactions,
  problems,
  type OpenPullRequest,
} from './rules.ts';

interface Node {
  number: number;
  title: string;
  createdAt: string;
  authorAssociation: string;
  author: { login: string; kind: string } | null;
  isCrossRepository: boolean;
  latestReviews: { nodes: { state: string; authorAssociation: string }[] };
  labels: { nodes: { name: string }[] };
  reactionGroups: { content: string; reactors: { totalCount: number } }[];
}

interface Page {
  repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } };
}

type Open = OpenPullRequest & { number: number; title: string };

const dryRun = process.argv.includes('--dry-run');
const maxFlag = process.argv.indexOf('--max-close');
const maxClose = maxFlag === -1 ? 20 : Number(process.argv[maxFlag + 1]);
if (!Number.isInteger(maxClose) || maxClose < 0) {
  process.stderr.write('--max-close takes a non-negative integer\n');
  process.exit(2);
}

/** Every open pull request, shaped for the rules. */
async function openPullRequests(): Promise<Open[]> {
  const all: Open[] = [];
  let after: string | null = null;
  do {
    const { repository }: Page = await graphql<Page>(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: OPEN, first: 100, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number title createdAt authorAssociation isCrossRepository
              latestReviews(first: 50) { nodes { state authorAssociation } }
              author { login kind: __typename }
              labels(first: 50) { nodes { name } }
              reactionGroups { content reactors { totalCount } }
            }
          }
        }
      }`,
      { after },
    );
    const page: Page['repository']['pullRequests'] = repository.pullRequests;
    for (const node of page.nodes) {
      all.push({
        number: node.number,
        title: node.title,
        createdAt: node.createdAt,
        author: {
          login: node.author?.login ?? 'ghost',
          association: node.authorAssociation,
          bot: node.author?.kind === 'Bot',
          fromFork: node.isCrossRepository,
        },
        labels: node.labels.nodes.map(({ name }) => name),
        reactions: node.reactionGroups.map(({ content, reactors }) => ({ content, count: reactors.totalCount })),
        approved: node.latestReviews.nodes.some(({ state, authorAssociation }) => state === 'APPROVED' && isMaintainer(authorAssociation)),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return all;
}

const now = new Date();
let closed = 0;

/** Closes one PR unless the cap is reached; returns false once it is. */
async function close(pr: Open, reason: string, after: () => Promise<void>): Promise<boolean> {
  if (closed >= maxClose) return false;
  closed++;
  console.log(`${dryRun ? 'would close' : 'closing'} #${pr.number} (${reason}): ${pr.title}`);
  if (!dryRun) await after();
  return true;
}

/**
 * Settles a flagged PR on its live title and body: clears a fixed one, closes
 * one still failing after the grace period, and re-flags one whose comment is gone.
 * Returns false once the close cap is reached.
 */
async function settleFlagged(pr: Open): Promise<boolean> {
  const found = problems(await livePullRequest(pr.number));
  const existing = await policyComment(pr.number);
  if (found.length === 0) {
    console.log(`${dryRun ? 'would clear' : 'clearing'} #${pr.number}: compliant now`);
    if (!dryRun) await clear(pr.number, existing);
    return true;
  }
  if (existing === undefined) {
    console.log(`${dryRun ? 'would re-flag' : 're-flagging'} #${pr.number}: label without a comment`);
    if (!dryRun) await flag(pr.number, found, true, undefined);
    return true;
  }
  if (!graceExpired(existing.created_at, now.getTime())) return true;
  return close(pr, 'not compliant after 72h', async () => {
    await closeWithComment(pr.number, COMPLIANCE_CLOSE_MESSAGE);
    await clear(pr.number, existing);
  });
}

for (const pr of await openPullRequests()) {
  if (pr.labels.includes(COMPLIANCE_LABEL) && isCommunity(pr.author)) {
    if (!(await settleFlagged(pr))) break;
    continue;
  }
  if (isStale(pr, now)) {
    const reason = `stale, ${positiveReactions(pr)} positive reaction(s)`;
    const ok = await close(pr, reason, async () => {
      await closeWithComment(pr.number, STALE_CLOSE_MESSAGE);
      await addLabel(pr.number, STALE_LABEL);
    });
    if (!ok) break;
  }
}
console.log(`${dryRun ? 'would close' : 'closed'} ${closed} PR(s)${closed >= maxClose ? ` (capped at ${maxClose})` : ''}`);
