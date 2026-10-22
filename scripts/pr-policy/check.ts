/**
 * Checks one community pull request against the policy in CONTRIBUTING.md
 * (`.github/workflows/pr-policy.yml`, on every open, edit, and push).
 *
 * A PR that falls short gets the `needs:compliance` label and one comment
 * listing what to fix, edited in place as the PR changes; `sweep.ts` closes it
 * once the grace period ends. A PR that is fixed loses both.
 *
 * Reads the `pull_request_target` payload from `GITHUB_EVENT_PATH`. Never
 * checks out or runs the PR's code. `--dry-run` prints the verdict and
 * changes nothing.
 */

import { readFileSync } from 'node:fs';
import { addLabel, comments, graphql, removeLabel, rest } from './github.ts';
import { COMPLIANCE_LABEL, COMPLIANCE_MARKER, POLICY_START, complianceComment, isCommunity, problems } from './rules.ts';

interface Payload {
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    created_at: string;
    author_association: string;
    user: { login: string; type: string };
    head: { repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
    labels: { name: string }[];
  };
}

const dryRun = process.argv.includes('--dry-run');
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  process.stderr.write('GITHUB_EVENT_PATH is required\n');
  process.exit(2);
}
const pr = (JSON.parse(readFileSync(eventPath, 'utf8')) as Payload).pull_request;

const author = {
  login: pr.user.login,
  association: pr.author_association,
  bot: pr.user.type === 'Bot',
  fromFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
};
if (!isCommunity(author)) {
  console.log(`#${pr.number}: ${author.login} is a maintainer or bot, skipping`);
  process.exit(0);
}
if (Date.parse(pr.created_at) < POLICY_START) {
  console.log(`#${pr.number}: opened before the policy, skipping`);
  process.exit(0);
}

const { repository } = await graphql<{ repository: { pullRequest: { closingIssuesReferences: { totalCount: number } } } }>(
  `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { closingIssuesReferences(first: 1) { totalCount } }
    }
  }`,
  { number: pr.number },
);
const found = problems({
  title: pr.title,
  body: pr.body ?? '',
  closingIssues: repository.pullRequest.closingIssuesReferences.totalCount,
});
console.log(found.length === 0 ? `#${pr.number}: compliant` : `#${pr.number}: ${found.length} problem(s)\n- ${found.join('\n- ')}`);
if (dryRun) process.exit(0);

const existing = (await comments(pr.number)).find(({ body }) => body.includes(COMPLIANCE_MARKER));
if (found.length > 0) {
  const body = complianceComment(found);
  if (existing === undefined) await rest(`/issues/${pr.number}/comments`, { method: 'POST', body: { body } });
  else if (existing.body !== body) await rest(`/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  await addLabel(pr.number, COMPLIANCE_LABEL);
} else {
  if (existing !== undefined) await rest(`/issues/comments/${existing.id}`, { method: 'DELETE' });
  await removeLabel(pr.number, COMPLIANCE_LABEL);
}
