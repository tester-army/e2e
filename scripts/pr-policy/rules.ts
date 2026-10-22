/**
 * The community pull request policy from CONTRIBUTING.md, as pure functions
 * shared by `check.ts` (one PR, on every edit) and `sweep.ts` (daily close).
 */

/** PRs opened before the policy landed are never flagged. */
export const POLICY_START = Date.parse('2026-10-23T00:00:00Z');

/** Label on a PR the check flagged; the sweep closes it after the grace period. */
export const COMPLIANCE_LABEL = 'needs:compliance';

/** Label on a PR the stale sweep closed, so a reopened one is not closed again. */
export const STALE_LABEL = 'stale-cleanup';

/** Hidden marker that finds the check's own comment. */
export const COMPLIANCE_MARKER = '<!-- pr-policy -->';

/** The account `GITHUB_TOKEN` comments as; only its marker comments count. */
export const BOT_LOGIN = 'github-actions[bot]';

const GUIDELINES = 'https://github.com/tester-army/e2e/blob/main/CONTRIBUTING.md#pull-requests';

export const GRACE_MS = 72 * 60 * 60 * 1000;

/** Stale sweep: open longer than a month with fewer than this many positive reactions. */
const STALE_REACTIONS = 2;

const POSITIVE_REACTIONS = new Set(['THUMBS_UP', 'HEART', 'HOORAY', 'ROCKET']);

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const TITLE = /^(feat|fix|docs|chore|refactor|test|perf|ci|build|revert)(\([^)]+\))?!?: \S/;

/** Types that need a linked issue; the rest are exempt. */
const ISSUE_EXEMPT = new Set(['feat', 'docs', 'refactor']);

const TEMPLATE_PLACEHOLDERS = new Set(['-', 'Ran it locally: yes | no - <why>']);

export interface Author {
  login: string;
  /** `author_association` from the REST payload, `authorAssociation` in GraphQL. */
  association: string;
  bot: boolean;
  /** The head branch lives in a fork. Only people with write access push branches here. */
  fromFork: boolean;
}

/** An owner, org member, or collaborator, from an `author_association`. */
export function isMaintainer(association: string): boolean {
  return MAINTAINER_ASSOCIATIONS.has(association);
}

/** Maintainers and bots are outside the policy. */
export function isCommunity(author: Author): boolean {
  return author.fromFork && !author.bot && !isMaintainer(author.association);
}

/** The body without HTML comments; an unclosed one hides the rest, as GitHub renders it. */
function withoutComments(body: string): string {
  let result = '';
  let from = 0;
  for (let start = body.indexOf('<!--'); start !== -1; start = body.indexOf('<!--', from)) {
    result += body.slice(from, start);
    const end = body.indexOf('-->', start + 4);
    if (end === -1) return result;
    from = end + 3;
  }
  return result + body.slice(from);
}

/** The text under a `## heading` of the PR body, HTML comments stripped. */
export function section(body: string, heading: string): string | undefined {
  const lines = withoutComments(body).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** A section with something beyond the template's placeholders. */
function filled(text: string | undefined): boolean {
  if (text === undefined) return false;
  return text.split('\n').some((line) => line.trim() !== '' && !TEMPLATE_PLACEHOLDERS.has(line.trim()));
}

/** Text outside the template's `## Issue`, `## Verified`, and `## Checklist`, under any heading or none. */
function described(body: string): boolean {
  const outside = withoutComments(body)
    .split(/^(?=##\s)/m)
    .filter((part) => !/^##\s+(issue|verified|checklist)\s*$/im.test(part.split(/\r?\n/, 1)[0] ?? ''))
    .map((part) => part.replace(/^##\s.*$/m, ''))
    .join('\n');
  return filled(outside);
}

/** An issue reference (`#123` or an issue URL) under `## Issue`. */
function referencesIssue(body: string): boolean {
  const text = section(body, 'Issue') ?? '';
  return /(^|[\s(])#\d+\b/.test(text) || /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.test(text);
}

export interface PullRequest {
  title: string;
  body: string;
  /** Issues GitHub will close on merge (`Fixes #123`), from `closingIssuesReferences`. */
  closingIssues: number;
}

/** What the PR must fix to meet the policy; empty when it does. */
export function problems(pr: PullRequest): string[] {
  const type = TITLE.exec(pr.title)?.[1];
  if (type === undefined) {
    return [
      'The title is not a [Conventional Commit](https://www.conventionalcommits.org): use `type(scope): summary`, for example `fix(web): keep the cursor after a reload`.',
    ];
  }
  const found: string[] = [];
  if (!ISSUE_EXEMPT.has(type) && pr.closingIssues === 0 && !referencesIssue(pr.body)) {
    found.push(`A \`${type}\` PR needs an existing issue. Open one if there is none, then add \`Fixes #123\` under \`## Issue\`.`);
  }
  if (!described(pr.body)) {
    found.push('The description is empty. Say what changes and why, in a few bullets.');
  }
  if (!filled(section(pr.body, 'Verified'))) {
    found.push('`## Verified` is missing or empty. Say how you checked the change works.');
  }
  return found;
}

/** The check's comment on a flagged PR. */
export function complianceComment(found: readonly string[]): string {
  return [
    COMPLIANCE_MARKER,
    `Thanks for the PR. It does not meet the [contributing guidelines](${GUIDELINES}) yet:`,
    '',
    ...found.map((problem) => `- ${problem}`),
    '',
    'Edit the PR within **72 hours** or it will be closed automatically. If this was flagged by mistake, say so here.',
  ].join('\n');
}

export const COMPLIANCE_CLOSE_MESSAGE =
  `Closed because it was not updated to meet the [contributing guidelines](${GUIDELINES}) within 72 hours. You are welcome to open a new PR that follows them.`;

export const STALE_CLOSE_MESSAGE = [
  'Closed by the automated stale sweep: this PR has been open for more than a month with fewer than 2 positive reactions (👍 ❤️ 🎉 🚀).',
  '',
  'If you are still working on it or think it should stay open, say so here and a maintainer can reopen it.',
].join('\n');

/** A flagged PR whose grace period, counted from the check's first comment, is over. */
export function graceExpired(flaggedAt: string, now: number): boolean {
  return now - Date.parse(flaggedAt) >= GRACE_MS;
}

/** The date one calendar month before `now`, clamped to the shorter month's last day. */
export function monthBefore(now: Date): Date {
  const result = new Date(now);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - 1);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

export interface OpenPullRequest {
  createdAt: string;
  author: Author;
  labels: readonly string[];
  /** GraphQL `reactionGroups`: content and how many users reacted with it. */
  reactions: readonly { content: string; count: number }[];
  /** A maintainer approved it. */
  approved: boolean;
}

/** Positive reactions on the PR itself. */
export function positiveReactions(pr: Pick<OpenPullRequest, 'reactions'>): number {
  return pr.reactions.filter(({ content }) => POSITIVE_REACTIONS.has(content)).reduce((total, { count }) => total + count, 0);
}

/** A community PR the stale sweep closes. Approved PRs and ones it closed before are kept. */
export function isStale(pr: OpenPullRequest, now: Date): boolean {
  return (
    isCommunity(pr.author) &&
    !pr.approved &&
    !pr.labels.includes(STALE_LABEL) &&
    Date.parse(pr.createdAt) < monthBefore(now).getTime() &&
    positiveReactions(pr) < STALE_REACTIONS
  );
}
