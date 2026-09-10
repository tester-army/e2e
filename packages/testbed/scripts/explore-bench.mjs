/**
 * Scores `e2e explore` against the bug garden's planted defects, across
 * models, all runs in parallel on their own app instance.
 *
 *   AI_GATEWAY_API_KEY=... node scripts/explore-bench.mjs \
 *     --models openai/gpt-5.6-luna-fast,google/gemini-3.6-flash --steps 8 --timeout 600000
 *
 * Each run writes under .e2e/explore-bench/<label>/ (report.json, artifacts,
 * cli.log); the matrix and the per-bug hits land in summary.json and on
 * stdout. A finding counts for a defect when its text matches the defect's
 * patterns; findings that match nothing are listed as "other" for a human to
 * judge: a real unplanted defect, or a false positive.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules', '@e2edev', 'e2e', 'dist', 'cli', 'bin.js');
const OUT = path.join(ROOT, '.e2e', 'explore-bench');

/** The planted defects and the patterns a finding about them matches (title + expected + actual). */
const BUGS = [
  { id: 'B1', kind: 'navigation', patterns: [/help/i, /hlep|404|not found|nothing at/i] },
  { id: 'B2', kind: 'dead control', patterns: [/add to cart/i, /nothing|no effect|no visible|unresponsive|dead|does not|doesn.t|did not|didn.t|stays|remains|not added|never/i] },
  { id: 'B3', kind: 'calculation', patterns: [/total/i, /quantit|qty|line|sum|ignore|incorrect|wrong|mismatch|should be|expected/i] },
  { id: 'B4', kind: 'wrong target', patterns: [/remov/i, /wrong|first|different|other|instead|another/i] },
  { id: 'B5', kind: 'persistence', patterns: [/name|profile|account/i, /sav|persist|revert/i, /old|previous|unchanged|revert|not (updated|changed|saved|persist|kept|applied|reflected)|still shows|did not (update|change|persist|stick)|lost|discard/i] },
  { id: 'B6', kind: 'dates', patterns: [/1970|1969|before (the|it was) (order|placed)|delivery date|placed on/i] },
  { id: 'B7', kind: 'security', patterns: [/password/i, /plain ?text|in (the )?clear|clear ?text|unmasked|not masked|no(t)? mask|readable|type="?text|visible (as|while) (you )?typ|exposed|echo|shows the (typed|entered)|displayed (as|in) (plain|clear)/i] },
  { id: 'B8', kind: 'copy', patterns: [/\{\{\s*userName\s*\}\}|template|placeholder token|unrendered|interpolat/i] },
  { id: 'B9', kind: 'data', patterns: [/stock/i, /-3|negative|minus|below zero/i] },
  { id: 'B10', kind: 'inconsistency', patterns: [/orders?/i, /count|2 orders|says (2|two)|one order|only one|mismatch|list(s|ed)? (only )?1|single/i] },
  { id: 'W1', kind: 'copy (minor)', patterns: [/recieve|misspell|typo|spelling/i] },
];

const args = parseArgs(process.argv.slice(2));
const models = (args.models ?? 'openai/gpt-5.6-luna-fast').split(',').map((value) => value.trim()).filter(Boolean);
const steps = args.steps ?? '8';
const timeout = args.timeout ?? '600000';
const goal =
  args.goal ??
  'Explore this bookshop like a careful first-time buyer: browse the catalog, add books to the cart, change quantities, remove one, check out, then visit the account, orders, and sign-in pages. Report every defect you have evidence of.';

const firstPort = Number(args.port ?? 4300);
// The index keeps two ids that slug alike apart.
const runs = models.map((model, index) => ({
  model,
  port: firstPort + index,
  label: `${String(index + 1).padStart(2, '0')}-${model.replace(/[^A-Za-z0-9.-]+/g, '_')}`,
}));

mkdirSync(OUT, { recursive: true });
// Every run settles on its own: one garden that fails to start is one row, not a lost matrix.
const results = (await Promise.allSettled(runs.map((run) => execute(run)))).map((settled, index) =>
  settled.status === 'fulfilled' ? settled.value : { ...runs[index], exitCode: -1, durationMs: 0, error: String(settled.reason?.message ?? settled.reason) },
);
const summary = { goal, steps: Number(steps), timeoutMs: Number(timeout), runs: results };
writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
print(results);

async function execute(run) {
  const dir = path.join(OUT, run.label);
  mkdirSync(dir, { recursive: true });
  const app = spawn(process.execPath, ['app/bug-garden.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(run.port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const startedAt = Date.now();
  try {
    await new Promise((resolve, reject) => {
      app.stdout.once('data', () => resolve());
      app.once('exit', (code) => reject(new Error(`bug garden exited with ${code} before listening`)));
    });
    const log = createWriteStream(path.join(dir, 'cli.log'));
    const cli = spawn(
      process.execPath,
      [CLI, 'explore', goal, '--config', 'e2e.explore.config.ts', '--max-steps', steps, '--timeout', timeout, '--artifacts', path.join(dir, 'artifacts'), '--debug'],
      {
        cwd: ROOT,
        env: { ...process.env, E2E_MODEL: run.model, EXPLORE_APP_URL: `http://127.0.0.1:${run.port}`, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    cli.stdout.pipe(log);
    cli.stderr.pipe(log);
    const exitCode = await new Promise((resolve) => cli.once('exit', (code) => resolve(code ?? -1)));
    return score(run, dir, exitCode, Date.now() - startedAt);
  } finally {
    app.kill();
  }
}

function score(run, dir, exitCode, durationMs) {
  let report;
  try {
    report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  } catch (cause) {
    return { ...run, exitCode, durationMs, error: `no report: ${cause.message}` };
  }
  const explore = report.run.explore ?? { steps: [], findings: [] };
  const hits = {};
  const other = [];
  for (const finding of explore.findings) {
    const text = `${finding.title}\n${finding.expected}\n${finding.actual}`;
    const bug = BUGS.find((candidate) => candidate.patterns.every((pattern) => pattern.test(text)));
    if (bug === undefined) other.push(`[${finding.kind} S${finding.severity}] ${finding.title}`);
    else (hits[bug.id] ??= []).push(finding.title);
  }
  return {
    ...run,
    exitCode,
    durationMs,
    status: report.run.status,
    ended: explore.ended,
    steps: explore.steps.map((step) => `${step.status}: ${step.title}`),
    findings: explore.findings.length,
    found: Object.keys(hits),
    other,
    modelTokens: report.run.usage.modelTokens,
    costUsd: report.run.usage.estimatedCostUsd,
    summary: explore.summary,
  };
}

function print(scored) {
  const ids = BUGS.map((bug) => bug.id);
  const width = Math.max(...scored.map((result) => result.label.length), 5);
  const line = (cells) => process.stdout.write(`${cells.join('  ')}\n`);
  line(['run'.padEnd(width), ...ids.map((id) => id.padEnd(3)), 'found', 'other', 'steps', 'cost', 'time']);
  for (const result of scored) {
    if (result.error !== undefined) {
      line([result.label.padEnd(width), result.error]);
      continue;
    }
    line([
      result.label.padEnd(width),
      ...ids.map((id) => (result.found.includes(id) ? ' ✓ ' : ' · ')),
      `${result.found.length}/${ids.length}`.padEnd(5),
      String(result.other.length).padEnd(5),
      String(result.steps.length).padEnd(5),
      result.costUsd === undefined ? '  ?  ' : `$${result.costUsd.toFixed(3)}`,
      `${Math.round(result.durationMs / 1000)}s`,
    ]);
  }
  for (const result of scored) {
    if (result.error !== undefined) continue;
    process.stdout.write(`\n== ${result.label} (${result.status}, ended: ${result.ended})\n`);
    for (const step of result.steps) process.stdout.write(`   step  ${step}\n`);
    for (const entry of result.other) process.stdout.write(`   other ${entry}\n`);
    if (result.summary) process.stdout.write(`   ${result.summary}\n`);
  }
  process.stdout.write(`\nsummary: ${path.join(OUT, 'summary.json')}\n`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    parsed[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}
