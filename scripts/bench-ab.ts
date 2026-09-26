/**
 * Main vs this branch, measured the same way every time. Builds the merge
 * base in a worktree under the system temp directory, builds the working
 * tree, then runs one benchmark suite through each build's own CLI in pairs,
 * in a seeded random order, until the suite's time change resolves against
 * the threshold or the pair budget runs out.
 *
 * Usage:
 *
 *   node scripts/bench-ab.ts [options] [-- <e2e run arguments>]
 *
 *   --base <ref>        compare against the merge base with this ref (origin/main)
 *   --suite <app>       the app under apps/ whose suite runs (web-benchmark)
 *   --config <file>     the suite config, relative to the app (its default)
 *   --workers <n>       e2e run --workers (1)
 *   --threshold <pct>   the change that counts, in percent (5)
 *   --floor <ms>        the smallest paired difference that counts (10)
 *   --min-pairs <n>     pairs before the first verdict (6)
 *   --max-pairs <n>     pairs at most (20)
 *   --batch <n>         pairs between verdicts (2)
 *   --warmup <n>        pairs run first and discarded (1)
 *   --timeout <min>     wall clock for the measured pairs (30)
 *   --seed <n>          order and bootstrap seed (1)
 *   --out <dir>         where result.json, summary.md, and the reports go
 *   --no-build          reuse the working tree's current build
 *   --rebuild-base      build the base worktree again
 *
 * Runs go with `CI=1`, so committed trace-cache recordings replay read-only,
 * `reuseExisting` servers start fresh per run, and no `GITHUB_*` variable is
 * passed, so the GitHub reporter never posts. A step without a recording
 * calls the model, which needs its key in the environment.
 *
 * Behavior is checked before time: a test whose status or step sequence
 * differs between the builds, or between two runs of one build, is listed
 * and left out of the timing rows. Wall-time verdicts from shared CI runners
 * are noise; read the behavior and counter sections there.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareSamples, SUITE } from './bench-ab/compare.ts';
import { renderMarkdown } from './bench-ab/markdown.ts';
import { sampleFromReport, type ReportDocument, type Sample } from './bench-ab/sample.ts';
import { seededRandom } from './bench-ab/stats.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const { values: options, positionals: forwarded } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'origin/main' },
    suite: { type: 'string', default: 'web-benchmark' },
    config: { type: 'string' },
    workers: { type: 'string', default: '1' },
    threshold: { type: 'string', default: '5' },
    floor: { type: 'string', default: '10' },
    'min-pairs': { type: 'string', default: '6' },
    'max-pairs': { type: 'string', default: '20' },
    batch: { type: 'string', default: '2' },
    warmup: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '30' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
    'no-build': { type: 'boolean', default: false },
    'rebuild-base': { type: 'boolean', default: false },
  },
});

/** A positive integer option, or exit 2 naming it. */
function integer(name: keyof typeof options, min = 1): number {
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < min) fail(`--${name} must be an integer of at least ${min}`);
  return value;
}

function fail(message: string): never {
  process.stderr.write(`bench-ab: ${message}\n`);
  process.exit(2);
}

function log(message: string): void {
  process.stderr.write(`bench-ab: ${message}\n`);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/** Runs a build command in `cwd`, streaming nothing unless it fails. */
function build(cwd: string, command: string, args: string[]): void {
  try {
    execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    fail(`${command} ${args.join(' ')} failed in ${cwd}\n${(output.stdout ?? '').slice(-4000)}${(output.stderr ?? '').slice(-4000)}`);
  }
}

/** The root build plus the suite app's own `build` script, when it has one. */
function buildCheckout(root: string, suite: string): void {
  build(root, 'pnpm', ['run', 'build']);
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps', suite, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  if (manifest.scripts?.['build'] !== undefined) build(path.join(root, 'apps', suite), 'pnpm', ['run', 'build']);
}

/** A worktree of `sha` under the temp directory, installed and built once. */
function baseCheckout(sha: string, suite: string): string {
  const root = path.join(os.tmpdir(), 'e2e-bench-ab', sha);
  const marker = path.join(root, '.bench-ab-built');
  if (!existsSync(root)) {
    log(`adding worktree ${root}`);
    git('worktree', 'add', '--detach', root, sha);
  }
  if (options['rebuild-base'] || !existsSync(marker) || readFileSync(marker, 'utf8') !== suite) {
    log(`installing and building base ${sha.slice(0, 8)}`);
    build(root, 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']);
    buildCheckout(root, suite);
    writeFileSync(marker, suite);
  }
  return root;
}

/** Digest of what a suite runs: its tests, configs, and committed recordings. */
function suiteDigest(appDir: string): string {
  const hash = createHash('sha256');
  const visit = (file: string): void => {
    if (!existsSync(file)) return;
    if (statSync(file).isDirectory()) {
      for (const entry of readdirSync(file).toSorted()) visit(path.join(file, entry));
      return;
    }
    hash.update(path.relative(appDir, file)).update(readFileSync(file));
  };
  for (const entry of readdirSync(appDir).toSorted()) {
    if (entry.startsWith('tests') || /^e2e\..*config\.m?ts$/.test(entry)) visit(path.join(appDir, entry));
  }
  visit(path.join(appDir, '.e2e', 'cache'));
  return hash.digest('hex');
}

/** The environment every run gets: CI semantics, no telemetry, no GitHub posting. */
function runEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (name.startsWith('GITHUB_')) delete env[name];
  return env;
}

/** The report's run-level errors, one per line, or nothing when there is no parsable report. */
function runErrors(text: string): string {
  try {
    const report = JSON.parse(text) as { run?: { errors?: readonly { code: string; message: string }[] } };
    return (report.run?.errors ?? []).map((error) => `${error.code}: ${error.message}\n`).join('');
  } catch {
    return '';
  }
}

/** One `e2e run` through the build at `root`; exits 2 on a run that did not produce test results. */
function runOnce(root: string, suite: string, runArgs: readonly string[], outDir: string): Promise<Sample> {
  const appDir = path.join(root, 'apps', suite);
  const artifacts = path.join(outDir, 'artifacts');
  const bin = path.join(appDir, 'node_modules', 'e2e', 'dist', 'cli', 'bin.js');
  const args = [bin, 'run', '--reporter', 'json', '--artifacts', artifacts, ...runArgs];
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, args, { cwd: appDir, env: runEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on('close', (code) => {
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const text = Buffer.concat(stdout).toString('utf8');
      writeFileSync(path.join(outDir, 'report.json'), text);
      rmSync(artifacts, { recursive: true, force: true });
      if (code !== 0 && code !== 1) fail(`e2e run exited ${code} in ${appDir}\n${runErrors(text)}${stderr}`);
      resolve(sampleFromReport(JSON.parse(text) as ReportDocument, wallMs));
    });
  });
}

function machine(): string {
  const cpus = os.cpus();
  const load = os.loadavg()[0]!;
  return `${os.platform()} ${os.arch()}, ${cpus[0]?.model ?? 'unknown CPU'} x${cpus.length}, Node ${process.versions.node}, load ${load.toFixed(1)}`;
}

const suite = options.suite;
const threshold = Number(options.threshold) / 100;
if (!(threshold > 0)) fail('--threshold must be a positive percent');
const floorMs = integer('floor', 0);
const minPairs = integer('min-pairs', 2);
const maxPairs = Math.max(integer('max-pairs', 2), minPairs);
const batch = integer('batch');
const warmup = integer('warmup', 0);
const timeoutMs = integer('timeout') * 60_000;
const seed = integer('seed', 0);
if (!existsSync(path.join(REPO_ROOT, 'apps', suite, 'package.json'))) fail(`no app at apps/${suite}`);

const baseSha = git('merge-base', options.base, 'HEAD');
const headSha = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain').length > 0;
const runArgs = [
  '--workers', options.workers,
  ...(options.config === undefined ? [] : ['--config', options.config]),
  ...forwarded,
];

const baseRoot = baseCheckout(baseSha, suite);
if (!options['no-build']) {
  log('building head');
  buildCheckout(REPO_ROOT, suite);
}
const suiteDiffers = suiteDigest(path.join(baseRoot, 'apps', suite)) !== suiteDigest(path.join(REPO_ROOT, 'apps', suite));
if (suiteDiffers) log('the suite differs between base and head; each side runs its own');
const cores = os.cpus().length;
if (os.loadavg()[0]! > cores / 2) log(`load average ${os.loadavg()[0]!.toFixed(1)} on ${cores} cores; timings will be noisy`);

const outRoot = path.resolve(options.out ?? path.join(os.tmpdir(), 'e2e-bench-ab', 'runs', new Date().toISOString().replaceAll(':', '-')));
mkdirSync(outRoot, { recursive: true });
const random = seededRandom(seed);
const base: Sample[] = [];
const head: Sample[] = [];
const order: ('base-first' | 'head-first')[] = [];

/** Runs one pair in a coin-flip order; warmup pairs are measured and dropped. */
async function pair(index: number, measured: boolean): Promise<void> {
  const headFirst = random() < 0.5;
  const dir = path.join(outRoot, measured ? `pair-${index}` : `warmup-${index}`);
  const sides = headFirst ? (['head', 'base'] as const) : (['base', 'head'] as const);
  const results: Partial<Record<'base' | 'head', Sample>> = {};
  for (const side of sides) {
    const outDir = path.join(dir, side);
    mkdirSync(outDir, { recursive: true });
    results[side] = await runOnce(side === 'base' ? baseRoot : REPO_ROOT, suite, runArgs, outDir);
  }
  if (!measured) return;
  base.push(results.base!);
  head.push(results.head!);
  order.push(headFirst ? 'head-first' : 'base-first');
  const suiteMs = (sample: Sample) => [...sample.cases.values()].reduce((sum, entry) => sum + entry.durationMs, 0);
  const b = suiteMs(results.base!);
  const h = suiteMs(results.head!);
  log(`pair ${index}: base ${(b / 1000).toFixed(2)} s, head ${(h / 1000).toFixed(2)} s (${headFirst ? 'head' : 'base'} first)`);
}

for (let index = 1; index <= warmup; index += 1) {
  log(`warmup pair ${index}`);
  await pair(index, false);
}
const started = Date.now();
/** The suite row's verdict over the tests whose behavior matched so far. */
const headlineVerdict = () => compareSamples(base, head, { threshold, floorMs }).timings.find((row) => row.name === SUITE)?.delta.verdict ?? 'unresolved';
let stop: string | undefined;
while (stop === undefined && base.length < maxPairs) {
  await pair(base.length + 1, true);
  const due = base.length >= minPairs && ((base.length - minPairs) % batch === 0 || base.length === maxPairs);
  if (!due) continue;
  if (headlineVerdict() !== 'unresolved') stop = `resolved after ${base.length} pairs`;
  else if (Date.now() - started > timeoutMs) stop = `stopped at the ${options.timeout}-minute timeout, unresolved`;
}
stop ??= `stopped at the ${maxPairs}-pair budget, unresolved`;

const comparison = compareSamples(base, head, { threshold, floorMs });
const header = {
  base: { ref: `merge base with ${options.base}`, sha: baseSha },
  head: { sha: headSha, dirty },
  suite: `apps/${suite}`,
  command: ['e2e run', ...runArgs].join(' '),
  threshold,
  floorMs,
  stop,
  machine: machine(),
  suiteDiffers,
};
const markdown = renderMarkdown(header, comparison);
const serialize = (sample: Sample) => ({
  exitCode: sample.exitCode,
  wallMs: sample.wallMs,
  counters: sample.counters,
  cases: Object.fromEntries([...sample.cases].map(([key, entry]) => [key, { durationMs: entry.durationMs, timings: entry.timings }])),
});
writeFileSync(path.join(outRoot, 'summary.md'), markdown);
writeFileSync(path.join(outRoot, 'result.json'), `${JSON.stringify({
  version: 'bench-ab/1',
  header,
  comparison,
  pairs: base.map((sample, index) => ({ pair: index + 1, order: order[index], base: serialize(sample), head: serialize(head[index]!) })),
}, null, 2)}\n`);
process.stdout.write(markdown);
log(`wrote ${path.join(outRoot, 'summary.md')} and result.json`);
