/**
 * E2E Bench command line.
 *
 *   node src/cli.ts run [--arms a,b] [--tracks act,judgment,explore,explore-clean]
 *                       [--repeats 3] [--concurrency 2] [--label name] [--dry-run]
 *   node src/cli.ts score <matrix dir>      rescore a raw matrix into a summary
 *   node src/cli.ts report [summary.json]   render a summary (default: the newest) as Markdown
 *
 * `run` needs `AI_GATEWAY_API_KEY` in the environment; it writes raw runs
 * under `.bench/<label>/` and the summary under `results/`. Arms default to
 * the core set (`ARMS` without calibration-only entries), tracks to all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { coreArms, selectArms, type Arm } from './catalog.ts';
import { checkPrerequisites, commandFor, planRuns, runMatrix } from './matrix.ts';
import { renderMarkdown } from './render.ts';
import { readAdjudications } from './score-explore.ts';
import { scoreRun } from './score-run.ts';
import { buildSummary, collectProvenance, latestSummary, readSummary, writeSummary, type Provenance } from './summary.ts';
import { selectTracks, TRACKS, type Track } from './tracks.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const RAW_DIR = path.join(PACKAGE_ROOT, '.bench');
const RESULTS_DIR = path.join(PACKAGE_ROOT, 'results');
const ADJUDICATIONS = path.join(PACKAGE_ROOT, 'adjudications.json');
/** Written next to the raw runs so `score` knows what the matrix was. */
const MATRIX_FILE = 'matrix.json';

interface MatrixRecord {
  readonly label: string;
  readonly createdAt: string;
  readonly arms: readonly string[];
  readonly tracks: readonly Track['id'][];
  readonly repeats: number;
  readonly provenance: Provenance;
}

const log = (line: string): void => void process.stderr.write(`${line}\n`);

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return run(rest);
    case 'score':
      return score(rest);
    case 'report':
      return report(rest);
    default:
      log('usage: bench run|score|report; see src/cli.ts');
      return 2;
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      arms: { type: 'string' },
      tracks: { type: 'string' },
      repeats: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '2' },
      label: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const arms = values.arms === undefined ? coreArms() : selectArms(list(values.arms));
  const tracks = values.tracks === undefined ? [...TRACKS] : selectTracks(list(values.tracks));
  const repeats = positiveInt(values.repeats, '--repeats');
  const concurrency = positiveInt(values.concurrency, '--concurrency');
  const createdAt = new Date().toISOString();
  const label = values.label ?? createdAt.slice(0, 19).replaceAll(/[:T]/g, '-');
  const outDir = path.join(RAW_DIR, label);
  if (values['dry-run']) {
    for (const planned of planRuns({ arms, tracks, repeats, outDir })) {
      const { cwd, args } = commandFor(planned, REPO_ROOT);
      log(`${planned.arm.id}/${planned.track.id}/r${String(planned.repeat)}  cd ${path.relative(REPO_ROOT, cwd)} && E2E_MODEL=${planned.arm.model} BENCH_PORT=${String(planned.port)} node ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`);
    }
    return 0;
  }
  const missing = checkPrerequisites(REPO_ROOT);
  if (missing.length > 0) {
    for (const line of missing) log(line);
    return 2;
  }
  if (process.env['AI_GATEWAY_API_KEY'] === undefined || process.env['AI_GATEWAY_API_KEY'] === '') {
    log('AI_GATEWAY_API_KEY is not set; every arm is a gateway model');
    return 2;
  }
  if (existsSync(outDir)) {
    log(`${outDir} exists; pick another --label or remove it`);
    return 2;
  }
  mkdirSync(outDir, { recursive: true });
  const record: MatrixRecord = {
    label,
    createdAt,
    arms: arms.map((arm) => arm.id),
    tracks: tracks.map((track) => track.id),
    repeats,
    provenance: collectProvenance(REPO_ROOT),
  };
  writeFileSync(path.join(outDir, MATRIX_FILE), `${JSON.stringify(record, null, 2)}\n`);
  await runMatrix({ root: REPO_ROOT, outDir, arms, tracks, repeats, concurrency, env: process.env, log });
  return summarize(outDir, record, arms, tracks);
}

async function score(argv: readonly string[]): Promise<number> {
  const dir = argv[0];
  if (dir === undefined) {
    log('usage: bench score <matrix dir>');
    return 2;
  }
  const outDir = path.resolve(dir);
  const record = JSON.parse(readFileSync(path.join(outDir, MATRIX_FILE), 'utf8')) as MatrixRecord;
  return summarize(outDir, record, selectArms(record.arms), selectTracks(record.tracks));
}

function summarize(outDir: string, record: MatrixRecord, arms: readonly Arm[], tracks: readonly Track[]): number {
  const adjudications = readAdjudications(ADJUDICATIONS);
  const scores = planRuns({ arms, tracks, repeats: record.repeats, outDir }).map((planned) =>
    scoreRun(planned.arm, planned.track, planned.repeat, planned.dir, adjudications),
  );
  const summary = buildSummary({
    label: record.label,
    createdAt: record.createdAt,
    provenance: record.provenance,
    arms,
    tracks,
    repeats: record.repeats,
    scores,
  });
  const file = writeSummary(RESULTS_DIR, summary);
  process.stdout.write(renderMarkdown(summary));
  log(`summary: ${path.relative(REPO_ROOT, file)}`);
  const unjudged = scores.flatMap((entry) => entry.explore?.other ?? []);
  if (unjudged.length > 0) {
    log(`${String(unjudged.length)} explore finding(s) await adjudication in adjudications.json:`);
    for (const finding of new Set(unjudged)) log(`  ${finding}`);
  }
  return 0;
}

async function report(argv: readonly string[]): Promise<number> {
  const file = argv[0] === undefined ? latestSummary(RESULTS_DIR) : path.resolve(argv[0]);
  if (file === undefined) {
    log(`no summaries under ${RESULTS_DIR}`);
    return 2;
  }
  process.stdout.write(renderMarkdown(readSummary(file)));
  return 0;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function positiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer, got "${value ?? ''}"`);
  return parsed;
}

process.exitCode = await main(process.argv.slice(2));
