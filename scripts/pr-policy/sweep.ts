/**
 * Daily close of community pull requests (`.github/workflows/pr-policy-sweep.yml`):
 *
 * - flagged by `check.ts` and not fixed within 72 hours of its comment;
 * - open for more than a month with fewer than 2 positive reactions, unless
 *   approved or reopened after an earlier sweep.
 *
 * `--dry-run` lists what it would close. `--max-close <n>` caps the closes
 * per run (default 20).
 */

import { closeWithComment, comments, graphql, addLabel, removeLabel } from './github.ts';
import {
  COMPLIANCE_CLOSE_MESSAGE,
  COMPLIANCE_LABEL,
  COMPLIANCE_MARKER,
  STALE_CLOSE_MESSAGE,
  STALE_LABEL,
  graceExpired,
  isCommunity,
  isStale,
  positiveReactions,
  type OpenPullRequest,
} from './rules.ts';

interface Node {
  number: number;
  title: string;
  createdAt: string;
  authorAssociation: string;
  author: { login: string; kind: string } | null;
  isCrossRepository: boolean;
  reviewDecision: string | null;
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
              number title createdAt authorAssociation isCrossRepository reviewDecision
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
        approved: node.reviewDecision === 'APPROVED',
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return all;
}

const now = new Date();
let closed = 0;

/** Closes one PR unless the cap is reached; returns false once it is. */
async function close(pr: Open, reason: string, message: string, label: { add?: string; remove?: string }): Promise<boolean> {
  if (closed >= maxClose) return false;
  closed++;
  console.log(`${dryRun ? 'would close' : 'closing'} #${pr.number} (${reason}): ${pr.title}`);
  if (dryRun) return true;
  await closeWithComment(pr.number, message);
  if (label.add !== undefined) await addLabel(pr.number, label.add);
  if (label.remove !== undefined) await removeLabel(pr.number, label.remove);
  return true;
}

for (const pr of await openPullRequests()) {
  if (pr.labels.includes(COMPLIANCE_LABEL) && isCommunity(pr.author)) {
    const flag = (await comments(pr.number)).find(({ body }) => body.includes(COMPLIANCE_MARKER));
    if (flag !== undefined && graceExpired(flag.created_at, now.getTime())) {
      if (!(await close(pr, 'not compliant after 72h', COMPLIANCE_CLOSE_MESSAGE, { remove: COMPLIANCE_LABEL }))) break;
      continue;
    }
  }
  if (isStale(pr, now)) {
    const reason = `stale, ${positiveReactions(pr)} positive reaction(s)`;
    if (!(await close(pr, reason, STALE_CLOSE_MESSAGE, { add: STALE_LABEL }))) break;
  }
}
console.log(`${dryRun ? 'would close' : 'closed'} ${closed} PR(s)${closed >= maxClose ? ` (capped at ${maxClose})` : ''}`);
