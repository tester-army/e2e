/**
 * The planner eval: runs `e2e explore --changed-since` on each fixture's
 * change with a real model and judges what the planner did with it. Each run
 * is the built CLI on a fresh git repository of the bookshop, its change
 * committed on top, against a static copy of the shop; only the explorer's
 * steps are scripted (`model.ts`), so a run costs a few planner calls.
 *
 *   pnpm --filter e2e run build
 *   AI_GATEWAY_API_KEY=... pnpm --filter e2e run eval:planner [options]
 *
 *   --models <ids>       gateway model ids, comma separated (E2E_MODEL, else openai/gpt-6-luna-fast)
 *   --judge <id>         the gateway model that answers the rubric questions (anthropic/claude-sonnet-5.5)
 *   --only <ids>         fixture ids, comma separated
 *   --repeat <n>         runs per fixture and model (3); a fixture passes with two thirds of them
 *   --concurrency <n>    runs at the same time (4)
 *   --max-steps <n>      steps each run may plan (1: the first charter is the one the change decides)
 *   --list               print the fixtures and exit
 *
 * Every run's project and report stay under tests/tmp-projects/planner-eval/; the
 * scorecard prints, and lands in summary.md and summary.json there (and in
 * the job summary on GitHub Actions). Exits 1 when a fixture fails.
 */

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gateway, generateText, Output } from 'ai';
import { z } from 'zod';
import { APP_SOURCE, FIXTURES, NAV_LABELS, SCREENS, TITLES, type PlannerFixture } from './fixtures.ts';
import { judgeRubric, judgeRun, type AskRubric, type Judgement, type PlannedRun } from './judges.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');
/** Inside the package, so a project's config resolves `ai` and `@e2e-dev/web` from it; ignored by git. */
const OUT = path.join(PACKAGE_ROOT, 'tests', 'tmp-projects', 'planner-eval');
/** The share of a fixture's runs that must pass. */
const PASS_SHARE = 2 / 3;
const RUN_TIMEOUT_MS = 240_000;

const { values: options } = parseArgs({
  options: {
    models: { type: 'string' },
    judge: { type: 'string', default: 'anthropic/claude-sonnet-5.5' },
    only: { type: 'string' },
    repeat: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    'max-steps': { type: 'string', default: '1' },
    list: { type: 'boolean', default: false },
  },
});

const repeat = positiveInteger('--repeat', options.repeat);
const concurrency = positiveInteger('--concurrency', options.concurrency);
const maxSteps = positiveInteger('--max-steps', options['max-steps']);
const models = (options.models ?? process.env['E2E_MODEL'] ?? 'openai/gpt-6-luna-fast').split(',').map((id) => id.trim()).filter(Boolean);
const only = options.only?.split(',').map((id) => id.trim()).filter(Boolean);
const unknown = only?.filter((id) => !FIXTURES.some((fixture) => fixture.id === id)) ?? [];
if (unknown.length > 0) fail(`unknown fixture ${unknown.join(', ')}; one of ${FIXTURES.map((fixture) => fixture.id).join(', ')}`);
const fixtures = only === undefined ? FIXTURES : FIXTURES.filter((fixture) => only.includes(fixture.id));
// A selection that evaluates nothing must not report a pass.
if (models.length === 0) fail('--models names no model');
if (fixtures.length === 0) fail('--only names no fixture');

if (options.list) {
  for (const fixture of fixtures) process.stdout.write(`${fixture.id.padEnd(26)} ${fixture.expect.decision.padEnd(7)} ${fixture.edgeCase}\n`);
  process.exit(0);
}
if (!process.env['AI_GATEWAY_API_KEY']) fail('AI_GATEWAY_API_KEY is not set: the planner eval calls real models through the AI Gateway');

interface Run {
  readonly model: string;
  readonly fixture: PlannerFixture;
  readonly index: number;
  readonly dir: string;
}

interface RunResult {
  readonly run: Run;
  readonly planned?: PlannedRun;
  readonly judgements: readonly Judgement[];
  readonly passed: boolean;
  readonly costUsd?: number | undefined;
  readonly durationMs: number;
  readonly error?: string;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const runs: Run[] = models.flatMap((model) =>
  fixtures.flatMap((fixture) =>
    Array.from({ length: repeat }, (_, index) => ({ model, fixture, index, dir: path.join(OUT, `${slug(model)}-${fixture.id}-${index + 1}`) })),
  ),
);
let done = 0;
const results = await pool(runs, concurrency, async (run) => {
  const result = await execute(run);
  done += 1;
  process.stderr.write(`[${done}/${runs.length}] ${run.model} ${run.fixture.id} #${run.index + 1}: ${result.error ?? (result.passed ? 'pass' : 'FAIL')}\n`);
  return result;
});

const card = scorecard(results);
process.stdout.write(`\n${card.text}\n`);
writeFileSync(path.join(OUT, 'summary.md'), `${card.text}\n`);
writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(card.json, null, 2)}\n`);
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `\`\`\`\n${card.text}\n\`\`\`\n`);
process.exit(card.passed ? 0 : 1);

/** One exploration of one fixture: a fresh repository, the CLI, the report, the judgement. */
async function execute(run: Run): Promise<RunResult> {
  const startedAt = Date.now();
  const project = path.join(run.dir, 'project');
  try {
    writeProject(project, run.fixture);
    const args = [CLI, 'explore', ...(run.fixture.goal === undefined ? [] : [run.fixture.goal]), '--changed-since', 'base', '--max-steps', String(maxSteps)];
    const shop = await startShop(run.fixture.screens ?? {});
    let exitCode: number;
    try {
      exitCode = await spawnCli(args, project, run, shop.url);
    } finally {
      await shop.close();
    }
    let report: { run: { explore?: PlannedRun; usage?: { estimatedCostUsd?: number } } };
    try {
      report = JSON.parse(readFileSync(path.join(project, '.e2e', 'report.json'), 'utf8'));
    } catch {
      return { run, judgements: [], passed: false, durationMs: Date.now() - startedAt, error: `no report (exit ${exitCode}); see ${path.join(run.dir, 'cli.log')}` };
    }
    const planned = report.run.explore;
    if (planned === undefined) return { run, judgements: [], passed: false, durationMs: Date.now() - startedAt, error: 'the report has no run.explore' };
    const judgements = [
      ...judgeRun(run.fixture.expect, planned),
      ...(await judgeRubric(run.fixture.expect.rubric ?? [], planned, askRubric)),
      ...pullRequestRead(run),
    ];
    return {
      run,
      planned,
      judgements,
      passed: judgements.every((judgement) => judgement.pass),
      costUsd: report.run.usage?.estimatedCostUsd,
      durationMs: Date.now() - startedAt,
    };
  } catch (cause) {
    return { run, judgements: [], passed: false, durationMs: Date.now() - startedAt, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** One rubric question to the judge model, answered in a fixed shape. */
async function askRubric(prompt: string): ReturnType<AskRubric> {
  const { output } = await generateText({
    model: gateway(options.judge),
    prompt,
    output: Output.object({ schema: z.object({ answer: z.enum(['yes', 'no']), reason: z.string() }) }),
  });
  return output;
}

/** The bookshop at `base`, the fixture's change committed on top, and a config whose model only plans. */
function writeProject(dir: string, fixture: PlannerFixture): void {
  writeFiles(dir, APP_SOURCE);
  git(dir, 'init', '--quiet');
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '-m', 'Bookshelf: catalog, cart, account, checkout');
  git(dir, 'branch', 'base');
  writeFiles(dir, fixture.change);
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '-m', fixture.message);
  // Written after the commits, as a CI checkout's config is not part of the change under review.
  const model = path.relative(dir, path.join(import.meta.dirname, 'model.ts')).split(path.sep).join('/');
  writeFileSync(
    path.join(dir, 'e2e.config.ts'),
    [
      "import { web } from '@e2e-dev/web';",
      "import { gateway } from 'ai';",
      `import { plannerOnly } from '${model}';`,
      '',
      'export default {',
      "  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL } }],",
      '  agents: {',
      '    default: {',
      "      model: plannerOnly(gateway(process.env.PLANNER_EVAL_MODEL ?? '')),",
      "      context: 'Bookshelf is a small online bookshop: a catalog, a cart, checkout, and an account page.',",
      '    },',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'e2e.config.ts\n');
}

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(dir, file);
    if (content === '') {
      rmSync(absolute, { force: true });
      continue;
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** Git with the user's config shut out, so a signing or hook setting can't change a fixture. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Bookshelf',
      GIT_AUTHOR_EMAIL: 'dev@bookshelf.test',
      GIT_COMMITTER_NAME: 'Bookshelf',
      GIT_COMMITTER_EMAIL: 'dev@bookshelf.test',
    },
  });
}

/** Runs the CLI in `cwd` with its output in the run's cli.log; resolves its exit code. */
function spawnCli(args: readonly string[], cwd: string, run: Run, appUrl: string): Promise<number> {
  const log: Buffer[] = [];
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...fixtureEnv(), ...pullRequestEnv(run), APP_URL: appUrl, PLANNER_EVAL_MODEL: run.model, E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1', FORCE_COLOR: '0', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => log.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => log.push(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
  return new Promise((resolve) => {
    child.once('close', (code) => {
      clearTimeout(timer);
      writeFileSync(path.join(run.dir, 'cli.log'), Buffer.concat(log));
      resolve(code ?? -1);
    });
  });
}

/** The environment without the job's own GitHub variables: no reporter posts, and the eval's own pull request never reaches a fixture. */
function fixtureEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GITHUB_')));
}

/** For a fixture with a pull request, whether the run said it planned from it: a passing run proves nothing if the text never arrived. */
function pullRequestRead(run: Run): Judgement[] {
  if (run.fixture.pullRequest === undefined) return [];
  const pass = readFileSync(path.join(run.dir, 'cli.log'), 'utf8').includes("planning from pull request #42's title and description");
  return [{ judge: 'pull request read', pass, detail: pass ? 'the run planned from the pull request' : 'the run never read the pull request: no notice in cli.log' }];
}

/** A GitHub Actions `pull_request` job's variables and event payload, for a fixture with a pull request. */
function pullRequestEnv(run: Run): NodeJS.ProcessEnv {
  const pull = run.fixture.pullRequest;
  if (pull === undefined) return {};
  const eventPath = path.join(run.dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42, title: pull.title, body: pull.body ?? null } }));
  return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
}

/** The bookshop's screens after the change, as a preview deploy serves them: the fixture's own over the shop's, a removed one gone from the nav too. */
async function startShop(overrides: Readonly<Record<string, string | null>>): Promise<{ url: string; close: () => Promise<void> }> {
  const bodies: Record<string, string | null> = { ...SCREENS, ...overrides };
  const present = Object.entries(bodies).filter((entry): entry is [string, string] => entry[1] !== null);
  const nav = `<nav>${present
    .filter(([pathname]) => NAV_LABELS[pathname] !== undefined)
    .map(([pathname]) => `<a href="${pathname}">${NAV_LABELS[pathname]}</a>`)
    .join(' ')}</nav>`;
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} - Bookshelf</title></head><body><header><strong>Bookshelf</strong> ${nav}</header><main><h1>${title}</h1>${body}</main></body></html>`;
  const pages = new Map(present.map(([pathname, body]) => [pathname, page(TITLES[pathname] ?? pathname, body)]));
  const server = createServer((request, response) => {
    const html = pages.get(new URL(request.url ?? '/', 'http://shop').pathname);
    response.writeHead(html === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html ?? page('Not found', '<p>Nothing here.</p>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Runs `work` over `items`, at most `limit` at a time, in order. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]!);
      }
    }),
  );
  return out;
}

/** The scorecard: one row per fixture and model, its runs below it with what failed. */
function scorecard(scored: readonly RunResult[]): { text: string; passed: boolean; json: unknown } {
  const lines: string[] = [];
  const rows: unknown[] = [];
  let passed = true;
  for (const model of models) {
    const cost = scored.filter((result) => result.run.model === model).reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
    lines.push(`== ${model} ($${cost.toFixed(3)})`);
    for (const fixture of fixtures) {
      const runsOf = scored.filter((result) => result.run.model === model && result.run.fixture === fixture);
      const passes = runsOf.filter((result) => result.passed).length;
      // A run that broke (no report, a judge that threw) is the harness's failure, on an observed fixture too.
      const broke = runsOf.some((result) => result.error !== undefined);
      const observed = fixture.expect.decision === 'any';
      const fixturePassed = !broke && (observed || passes >= Math.ceil(runsOf.length * PASS_SHARE));
      passed &&= fixturePassed;
      const mark = !fixturePassed ? '✗' : observed ? '·' : '✓';
      lines.push(`${mark} ${fixture.id} [${passes}/${runsOf.length}] ${fixture.edgeCase}`);
      for (const result of runsOf) {
        lines.push(`    #${result.run.index + 1} ${describe(result)}`);
        for (const judgement of result.judgements) if (!judgement.pass) lines.push(`       FAIL ${judgement.judge}: ${judgement.detail}`);
      }
      rows.push({
        model,
        fixture: fixture.id,
        expected: fixture.expect.decision,
        passed: fixturePassed,
        runs: runsOf.map((result) => ({ passed: result.passed, error: result.error, planned: result.planned, judgements: result.judgements, costUsd: result.costUsd, durationMs: result.durationMs })),
      });
    }
    lines.push('');
  }
  lines.push(`planner eval: ${passed ? 'PASS' : 'FAIL'} (${scored.length} runs, ${fixtures.length} fixtures, ${models.length} model${models.length === 1 ? '' : 's'})`);
  return { text: lines.join('\n'), passed, json: { models, repeat, maxSteps, passed, fixtures: rows } };
}

function describe(result: RunResult): string {
  if (result.error !== undefined) return `error: ${result.error}`;
  const planned = result.planned!;
  const seconds = `${Math.round(result.durationMs / 1000)}s`;
  if (planned.ended === 'skipped') return `skip (${seconds}): ${planned.summary ?? ''}`;
  const first = planned.steps[0];
  return `${planned.steps.length} step${planned.steps.length === 1 ? '' : 's'}, ended ${planned.ended} (${seconds})${first === undefined ? '' : `: "${first.title}"`}`;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9.-]+/g, '_');
}

function positiveInteger(flag: string, value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${flag} must be a positive integer, got "${value}"`);
  return number;
}

function fail(message: string): never {
  process.stderr.write(`planner eval: ${message}\n`);
  process.exit(2);
}
