/**
 * Renders the App Store readiness report from the last `test:appstore` run:
 * the verdicts the checks recorded in `.e2e/appstore/findings.jsonl`, joined
 * with the runner's JSON report for coverage (which checks ran to a verdict,
 * which stalled). Writes `.e2e/appstore/report.md` and prints a summary.
 * Exits 1 when a rejection-level violation was found, a check did not reach
 * a verdict, or the runner itself did not pass (or left no report), so the
 * readiness call is the process exit code.
 *
 * Usage: node scripts/appstore-report.mjs [report.json] [findings.jsonl]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const reportPath = process.argv[2] ?? '.e2e/report.json';
const findingsPath = process.argv[3] ?? '.e2e/appstore/findings.jsonl';
const outputPath = '.e2e/appstore/report.md';

const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
const findings = existsSync(findingsPath)
  ? readFileSync(findingsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  : [];

// Keep the latest verdict per check when a retry recorded it twice.
const latest = new Map();
for (const finding of findings) latest.set(`${finding.guideline.id} ${finding.check}`, finding);

const RANK = { 'rejection violation': 0, 'advisory violation': 1, unverified: 2, compliant: 3, 'not-applicable': 4 };
const bucket = (finding) =>
  finding.verdict === 'violation' ? `${finding.guideline.severity} violation` : finding.verdict;
const MARK = {
  'rejection violation': '❌',
  'advisory violation': '⚠️',
  unverified: '❔',
  compliant: '✅',
  'not-applicable': '➖',
};
const LABEL = {
  'rejection violation': 'Rejection risk',
  'advisory violation': 'Advisory',
  unverified: 'Unverified',
  compliant: 'Compliant',
  'not-applicable': 'Not applicable',
};

const ordered = [...latest.values()].toSorted(
  (a, b) => RANK[bucket(a)] - RANK[bucket(b)] || a.guideline.id.localeCompare(b.guideline.id, 'en', { numeric: true }),
);
const counts = Object.fromEntries(Object.keys(RANK).map((key) => [key, 0]));
for (const finding of ordered) counts[bucket(finding)] += 1;

const results = report?.run?.results ?? [];
const incomplete = [];
const coverage = results.map((result) => {
  const attempt = result.attempts?.at(-1);
  const title = result.titlePath.at(-1);
  const reachedVerdict = findingsForTest(title).length > 0;
  const error = attempt?.error?.message ?? '';
  const stalled = !reachedVerdict && result.status !== 'passed';
  if (stalled) incomplete.push({ title, error });
  return { title, status: result.status, durationMs: attempt?.durationMs ?? 0, stalled, error };
});

/** Findings a test produced: matched by the guideline ids in the test title. */
function findingsForTest(title) {
  const ids = title.match(/\d+(?:\.\d+)*(?:\([a-z]+\))?/g) ?? [];
  return ordered.filter((finding) => ids.some((id) => finding.guideline.id.startsWith(id)));
}

const appName = ordered[0]?.app ?? process.env.E2E_APP ?? process.env.E2E_APP_PATH ?? 'unknown app';
const runLine = report
  ? `Run ${report.run.id} on ${report.run.startedAt}, runner ${report.run.runner.name} ${report.run.runner.version}, status ${report.run.status}.`
  : 'No runner report found; findings only.';
// A runner that did not pass, or wrote no report, is not a clean audit even
// when every recorded finding is clean: a stale or missing report must not
// read as readiness.
const runFailed = report === null || report.run.status !== 'passed';
const verdictLine =
  counts['rejection violation'] > 0
    ? `**Not ready for review:** ${counts['rejection violation']} rejection risk(s).`
    : incomplete.length > 0
      ? `**Audit incomplete:** ${incomplete.length} check(s) did not reach a verdict.`
      : runFailed
        ? `**Audit incomplete:** ${report === null ? 'no runner report was written' : `the runner reported status ${report.run.status}`}.`
      : counts.unverified > 0
        ? `**No rejection risk found**, ${counts.unverified} check(s) need a second pass.`
        : '**No rejection risk found.**';

const fmtDuration = (ms) => `${Math.round(ms / 1000)}s`;
const esc = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const lines = [];
lines.push(`# App Store readiness report: ${appName}`, '');
lines.push(runLine, '');
lines.push(verdictLine, '');
lines.push(
  Object.keys(RANK)
    .map((key) => `${MARK[key]} ${LABEL[key]}: ${counts[key]}`)
    .join(' · '),
  '',
);
lines.push('| | Guideline | Check | Result |', '|---|---|---|---|');
for (const finding of ordered) {
  lines.push(
    `| ${MARK[bucket(finding)]} | ${esc(finding.guideline.id)} ${esc(finding.guideline.title)} | ${esc(finding.check)} | ${esc(finding.summary)} |`,
  );
}
if (ordered.length === 0) lines.push('| | | | no verdicts recorded |');
lines.push('');

lines.push('## Findings', '');
for (const finding of ordered) {
  lines.push(`### ${MARK[bucket(finding)]} ${finding.guideline.id} ${finding.guideline.title}: ${finding.check}`, '');
  lines.push(`${LABEL[bucket(finding)]}. ${finding.summary}`, '');
  if (finding.evidence.length > 0) {
    lines.push('Evidence:', '');
    for (const item of finding.evidence) lines.push(`- ${item}`);
    lines.push('');
  }
  if (finding.screenshots.length > 0) {
    lines.push(`Screenshots: ${finding.screenshots.map((shot) => `\`${shot}\``).join(', ')}`, '');
  }
  lines.push(`Reference: <${finding.guideline.url}>`, '');
}

lines.push('## Coverage', '');
if (coverage.length === 0) lines.push('No runner report; coverage unknown.', '');
for (const entry of coverage) {
  const mark = entry.stalled ? '⛔' : entry.status === 'passed' ? '✅' : '❌';
  const note = entry.stalled ? ` (no verdict: ${entry.error || entry.status})` : '';
  lines.push(`- ${mark} ${entry.title}, ${entry.status} in ${fmtDuration(entry.durationMs)}${note}`);
}
lines.push('');
lines.push(
  '_Verdicts are an AI agent reading the app through its accessibility tree and screenshots on a simulator: a fast first pass, not a review outcome or legal advice. Rejection risks name the guideline App Review cites; check the referenced text before shipping a fix._',
  '',
);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, lines.join('\n'));

console.log(`${verdictLine.replace(/\*\*/g, '')} Report: ${outputPath}`);
for (const finding of ordered.filter((f) => bucket(f) !== 'compliant' && bucket(f) !== 'not-applicable')) {
  console.log(`  ${MARK[bucket(finding)]} ${finding.guideline.id} ${finding.check}: ${finding.summary}`);
}
for (const entry of incomplete) console.log(`  ⛔ ${entry.title}: ${entry.error || 'no verdict'}`);

process.exit(runFailed || counts['rejection violation'] > 0 || incomplete.length > 0 ? 1 : 0);
