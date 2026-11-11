/**
 * Gives a pull request one `size:*` label from its changed lines
 * (`.github/workflows/pr-size.yml`, on every open and push).
 *
 * Reads the PR number from the `pull_request_target` payload at
 * `GITHUB_EVENT_PATH` and the changed files and labels live, over `fetch`
 * with `GITHUB_TOKEN` against `GITHUB_REPOSITORY`. Never checks out or runs
 * the PR's code. `--dry-run` prints the size and changes nothing.
 */

import { readFileSync } from 'node:fs';
import { SIZE_LABELS, sizeOf, type ChangedFile } from './size.ts';

const API = 'https://api.github.com';
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!token || !repo || !eventPath) {
  process.stderr.write('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH are required\n');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');
const { number } = (JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request: { number: number } }).pull_request;

/** One authenticated request under `/repos/{owner}/{name}`; throws on a non-2xx response. */
async function rest(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(`${API}/repos/${repo}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

/** Every file the PR changes; GitHub lists at most 3,000, already past `size:XXL`. */
async function changedFiles(): Promise<ChangedFile[]> {
  const all: ChangedFile[] = [];
  for (let page = 1; ; page++) {
    const batch = (await rest(`/pulls/${number}/files?per_page=100&page=${page}`)) as ChangedFile[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

const size = sizeOf(await changedFiles());
console.log(`#${number}: ${size.counted} counted of ${size.total} changed lines -> ${size.label.name}`);
if (dryRun) process.exit(0);

const current = ((await rest(`/issues/${number}/labels?per_page=100`)) as { name: string }[]).map(({ name }) => name);
for (const name of current) {
  if (name !== size.label.name && SIZE_LABELS.some((label) => label.name === name)) {
    await rest(`/issues/${number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
}
if (!current.includes(size.label.name)) {
  const { name, max, color } = size.label;
  const description = `${max === Infinity ? '1,000+' : `Up to ${max}`} changed lines, not counting tests, fixtures, or the lockfile`;
  try {
    await rest('/labels', { method: 'POST', body: { name, color, description } });
  } catch (error) {
    if (!String(error).includes(': 422 ')) throw error;
  }
  await rest(`/issues/${number}/labels`, { method: 'POST', body: { labels: [name] } });
}
