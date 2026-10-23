/**
 * Checks one community pull request against the policy in CONTRIBUTING.md
 * (`.github/workflows/pr-policy.yml`, on every open, edit, and push).
 *
 * A PR that falls short gets the `needs:compliance` label and one comment
 * listing what to fix, edited in place as the PR changes; `sweep.ts` closes it
 * once the grace period ends. A PR that is fixed loses both.
 *
 * Reads the author from the `pull_request_target` payload at
 * `GITHUB_EVENT_PATH` and the title, body, and labels live. Never
 * checks out or runs the PR's code. `--dry-run` prints the verdict and
 * changes nothing.
 */

import { readFileSync } from 'node:fs';
import { clear, flag, livePullRequest, policyComment } from './github.ts';
import { COMPLIANCE_LABEL, POLICY_START, isCommunity, problems } from './rules.ts';

interface Payload {
  pull_request: {
    number: number;
    created_at: string;
    author_association: string;
    user: { login: string; type: string };
    head: { repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
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

const live = await livePullRequest(pr.number);
const found = problems(live);
console.log(found.length === 0 ? `#${pr.number}: compliant` : `#${pr.number}: ${found.length} problem(s)\n- ${found.join('\n- ')}`);
if (dryRun) process.exit(0);

const existing = await policyComment(pr.number);
if (found.length > 0) await flag(pr.number, found, live.labels.includes(COMPLIANCE_LABEL), existing);
else await clear(pr.number, existing);
