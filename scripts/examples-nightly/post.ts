/**
 * Posts the nightly examples run to Slack as one message
 * (`.github/workflows/examples.yml`, the `summary` job).
 *
 * Reads every `outcome.json` (and the `report.json` beside it, when the tests
 * ran, and `first-pass/second-pass`, when `run-tests.sh` gave the suite a
 * second pass) under the directory given as the first argument, one directory per
 * matrix job, as `actions/download-artifact` lays them out. Lists the run's
 * jobs through the API to link each line to its log and to name a job that
 * ended without writing an outcome.
 *
 * Environment: `SLACK_EXAMPLES_NIGHTLY_WEBHOOK_URL` (an incoming webhook; without it the
 * message is printed and the script exits 1), `GITHUB_TOKEN`,
 * `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
 * `GITHUB_SERVER_URL`, `GITHUB_SHA`, `PACK_RESULT` (the `pack` job's
 * result), and `PACK_CREDENTIAL` (`missing` when the model key stopped it). `--dry-run` prints the message and posts nothing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatMessage, type Outcome, type ReportCounts, type Row, type SecondPass } from './format.ts';

const MATRIX_JOB = /^(web|android|ios) /;

/** The counts and duration of one `report-1` file. */
function readReport(path: string): ReportCounts | undefined {
  if (!existsSync(path)) return undefined;
  const { run } = JSON.parse(readFileSync(path, 'utf8')) as {
    run: { startedAt: string; finishedAt?: string; summary: Omit<ReportCounts, 'durationMs'> };
  };
  const { passed, failed, flaky, skipped, interrupted } = run.summary;
  return {
    passed,
    failed,
    flaky,
    skipped,
    interrupted,
    ...(run.finishedAt === undefined ? {} : { durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt) }),
  };
}

/** The second pass `run-tests.sh` recorded, if the suite needed one. */
function readSecondPass(path: string): SecondPass | undefined {
  if (!existsSync(path)) return undefined;
  const kind = readFileSync(path, 'utf8').trim();
  return kind === 'last-failed' || kind === 'full' ? kind : undefined;
}

/** The run's jobs by name, with their log URLs; undefined when the API cannot be read. */
async function listJobs(): Promise<Map<string, string> | undefined> {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  const jobs = new Map<string, string>();
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT ?? '1'}/jobs?per_page=100`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = (await response.json()) as { jobs: { name: string; html_url: string }[] };
    for (const job of body.jobs) jobs.set(job.name, job.html_url);
  } catch (error) {
    process.stderr.write(`::warning::could not list the run's jobs: ${String(error)}\n`);
    return undefined;
  }
  return jobs;
}

/** Why the `pack` job stopped the run, if it did. */
function packBlocked(): 'credential' | 'pack' | undefined {
  const result = process.env.PACK_RESULT;
  if (result === undefined || result === 'success') return undefined;
  return process.env.PACK_CREDENTIAL === 'missing' ? 'credential' : 'pack';
}

const dir = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
if (dir === undefined) {
  process.stderr.write('usage: node scripts/examples-nightly/post.ts <outcomes dir> [--dry-run]\n');
  process.exit(2);
}

const jobs = await listJobs();
const rows: Row[] = [];
for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
  const outcomePath = join(dir, entry, 'outcome.json');
  if (!existsSync(outcomePath)) continue;
  const outcome = JSON.parse(readFileSync(outcomePath, 'utf8')) as Outcome;
  const report = readReport(join(dir, entry, 'report.json'));
  const secondPass = readSecondPass(join(dir, entry, 'first-pass', 'second-pass'));
  const jobUrl = jobs?.get(outcome.job);
  rows.push({
    outcome,
    ...(report === undefined ? {} : { report }),
    ...(secondPass === undefined ? {} : { secondPass }),
    ...(jobUrl === undefined ? {} : { jobUrl }),
  });
}
const reported = new Set(rows.map((row) => row.outcome.job));
const missing = [...(jobs?.keys() ?? [])].filter((name) => MATRIX_JOB.test(name) && !reported.has(name));

const blocked = packBlocked();
const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const message = formatMessage(rows, {
  runUrl: `${server}/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`,
  sha: process.env.GITHUB_SHA ?? 'unknown',
  ...(blocked === undefined ? {} : { blocked }),
  missing,
  jobsUnknown: jobs === undefined,
});
process.stdout.write(`${message}\n`);

const webhook = process.env.SLACK_EXAMPLES_NIGHTLY_WEBHOOK_URL;
if (dryRun) process.exit(0);
if (!webhook) {
  process.stderr.write('::error::SLACK_EXAMPLES_NIGHTLY_WEBHOOK_URL is not set for this repository, so the summary was not posted.\n');
  process.exit(1);
}
const response = await fetch(webhook, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: message }),
});
if (!response.ok) {
  process.stderr.write(`::error::Slack refused the summary: ${response.status} ${await response.text()}\n`);
  process.exit(1);
}
