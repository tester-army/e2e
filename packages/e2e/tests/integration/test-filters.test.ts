/**
 * Test filters (`filters` in the config, on by default, `--no-filter` /
 * `noFilter` to skip them) through the runner, the public `e2e/runner` API,
 * and the built CLI on the fake engine: what a filter is given, what it
 * leaves out and why, a run it leaves empty booting nothing, its failures,
 * the deadline, and interrupts, `e2e list` as the dry run, each shard judging
 * only its own slice, and the serial groups and sessions core settles after
 * it. Filters run only on a change: each project here is a git repository
 * whose `feature` branch changes `src/app.ts`, judged with `changedSince:
 * 'main'`, and the environment is scrubbed of CI, so no run detects a pull
 * request it is not.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import type { ListedPair, ListOptions } from '../../src/run/runner.ts';
import type { RunEvent } from '../../src/run/events.ts';
import type { ModuleRegistration } from '../../src/collect/registry.ts';
import type { E2EConfig, TestFilter, TestFilterCandidate, TestFilterContext } from '../../src/types.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { commitFiles, initRepo, runGit } from '../helpers/git-repo.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, listExisting as listProjectAs, runExisting as runProjectAs, type FixtureProject, type RunProjectOptions } from '../helpers/run-project.ts';
import { STARTUP_SCRIPTS } from '../helpers/startup-scripts.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const publicRunner = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

type Target = NonNullable<E2EConfig['targets']>[number];

/** Whether the fixture projects' filesystem ignores case, as default macOS and Windows do. */
const CASE_INSENSITIVE = existsSync(fileURLToPath(import.meta.url).toUpperCase()) && existsSync(fileURLToPath(import.meta.url).toLowerCase());

/** The environment of every run here: outside CI, so no run detects a pull or merge request. */
const LOCAL_ENV: NodeJS.ProcessEnv = { ...process.env, CI: '', GITHUB_ACTIONS: '', GITLAB_CI: '' };

/**
 * A fixture project removed after the test, made a git repository: `files`
 * and `src/app.ts` are the base commit on `main`, and the `feature` branch,
 * checked out, commits `change` (`src/app.ts` edited unless given). Files
 * the runs write later are ignored, so the change stays what was committed.
 */
function fixture(files: Readonly<Record<string, string>>, change: Readonly<Record<string, string>> = { 'src/app.ts': 'export const version = 2;\n' }): FixtureProject {
  const created = createProject(files);
  projects.push(created);
  initRepo(created.dir);
  commitFiles(created.dir, { 'src/app.ts': 'export const version = 1;\n' }, 'base');
  runGit(created.dir, 'checkout', '--quiet', '-b', 'feature');
  commitFiles(created.dir, change, 'feature');
  writeFileSync(path.join(created.dir, '.git', 'info', 'exclude'), '*\n');
  return created;
}

/** The merge base the filters judge the fixture's change from: the tip of `main`. */
function baseOf(project: FixtureProject): string {
  return runGit(project.dir, 'rev-parse', 'main');
}

/** `listExisting` outside CI, judging the change since `main` unless `options` says otherwise. */
function listExisting(project: FixtureProject, options: Partial<ListOptions> = {}) {
  return listProjectAs(project, { env: LOCAL_ENV, changedSince: 'main', ...options });
}

/** `runExisting` outside CI, judging the change since `main` unless `runOptions` says otherwise. */
function runExisting(project: FixtureProject, options: RunProjectOptions) {
  return runProjectAs(project, { ...options, runOptions: { env: LOCAL_ENV, changedSince: 'main', ...options.runOptions } });
}

/** A test file declaring one empty test, with `options` (such as `{ tags: ['smoke'] }`) when given. */
function testFile(title: string, options?: string): string {
  return `import { test } from 'e2e';\ntest(${JSON.stringify(title)}, ${options === undefined ? '' : `${options}, `}async () => {});\n`;
}

/** Three one-test files, `alpha`, `beta`, and `gamma`, in that order. */
const THREE_TESTS = {
  'tests/alpha.e2e.ts': testFile('alpha'),
  'tests/beta.e2e.ts': testFile('beta'),
  'tests/gamma.e2e.ts': testFile('gamma'),
} as const;

/** A candidate's own title: the last of its title path. */
function titleOf(test: TestFilterCandidate): string {
  return test.titlePath.at(-1)!;
}

/** A filter that leaves out every test but those titled `keep`, each with a reason naming it. */
function keepOnly(name: string, keep: readonly string[]): TestFilter {
  return {
    name,
    filter: (tests) => ({
      exclude: Object.fromEntries(tests.filter((test) => !keep.includes(titleOf(test))).map((test) => [test.id, `the diff misses ${titleOf(test)}`])),
    }),
  };
}

/**
 * A fake target whose engine `prepare` writes `prepared` into `dir` and whose
 * app command logs `app` to `startup.log` there, so a run that boots either
 * leaves a file behind.
 */
async function markedTarget(dir: string): Promise<Target> {
  const fake = createFakeEngine({ state: true }).engine;
  const port = await freePort();
  return {
    name: 'fake',
    platform: 'fake',
    engine: {
      ...fake,
      async prepare() {
        writeFileSync(path.join(dir, 'prepared'), '');
      },
    },
    app: { url: `http://127.0.0.1:${port}`, command: { executable: process.execPath, args: ['server.cjs', String(port)] } },
  };
}

/** The report the last run wrote to disk, schema-checked. */
function reportOf(project: FixtureProject): Report1Document {
  const report = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as Report1Document;
  assertValidReport(report);
  return report;
}

/** The raw bytes of the report on disk, to prove a failed run left it alone. */
function reportBytes(project: FixtureProject): string {
  return readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8');
}

/** One report row by its test title. */
function row(report: Report1Document, title: string) {
  const found = report.run.results.find((result) => result.titlePath.at(-1) === title);
  if (found === undefined) throw new Error(`no row titled "${title}"; got ${report.run.results.map((result) => result.titlePath.join(' > ')).join(', ')}`);
  return found;
}

/** The titles of the ordinary tests the run executed, sorted. */
function executedTests(report: Report1Document): string[] {
  return report.run.results
    .filter((result) => result.kind === 'test' && result.selected)
    .map((result) => result.titlePath.at(-1)!)
    .toSorted();
}

/** Run events as short strings: setup steps with their state, notices with target and message, else the type. */
function describeEvent(event: RunEvent): string {
  if (event.type === 'setup') return `setup:${event.step.kind}${event.step.kind === 'filter' ? `(${event.step.name})` : ''}:${event.state}`;
  if (event.type === 'notice') return `notice:${event.target}:${event.message}`;
  return event.type;
}

/** Resolves once `check` holds, polling every 20 ms; rejects after `timeoutMs`. */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A file-backed config on the fake engine for the CLI: `filters` is the
 * source of the `filters` list, `preamble` code the filters need, `target`
 * the source of the one target, and `secrets` the source of the secrets map.
 */
function cliConfig(
  filters: string,
  options: { preamble?: string; target?: string; secrets?: string } = {},
): string {
  return `import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { E2EConfig, TestFilter } from 'e2e';
import { ConfigurationError } from 'e2e/engine';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
${options.preamble ?? ''}
export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [${options.target ?? "{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }"}],
  workers: 1,
  cache: 'off',
  filters: ${filters},${options.secrets === undefined ? '' : `\n  secrets: ${options.secrets},`}
} satisfies E2EConfig;
`;
}

/** Runs one CLI command in `project`, outside CI and without color, with `env` over the process environment; filters need `--changed-since main` to run. */
function cli(project: FixtureProject, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project.dir,
    env: { ...LOCAL_ENV, NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

describe('test filters on a run', () => {
  it('runs every configured filter on a change, leaving out the tests it names with its reasons, after collection and before the plan', async () => {
    const project = fixture(THREE_TESTS);
    const given: { tests: readonly TestFilterCandidate[]; context: TestFilterContext }[] = [];
    const areas = keepOnly('areas', ['alpha']);
    const events: string[] = [];
    const outcome = await runExisting(project, {
      config: {
        filters: [
          {
            name: 'areas',
            filter(tests, context) {
              given.push({ tests, context });
              context.log(`judging ${tests.length} tests`);
              return areas.filter(tests, context);
            },
          },
        ],
      },
      runOptions: { onEvent: (event) => { events.push(describeEvent(event)); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');

    // The filter got the collected tests by id, file, title path, and tags,
    // never their bodies, plus the run's context.
    expect(given).toHaveLength(1);
    const [{ tests, context }] = given as [(typeof given)[number]];
    expect(tests.map((test) => ({ ...test }))).toEqual(
      ['alpha', 'beta', 'gamma'].map((title) => ({ id: row(reportOf(project), title).testId, file: `tests/${title}.e2e.ts`, titlePath: [title], tags: [] })),
    );
    expect(Object.isFrozen(tests)).toBe(true);
    expect(context.projectRoot).toBe(project.dir);
    expect(context.signal.aborted).toBe(false);
    const base = baseOf(project);
    expect(context.changes).toEqual({ base, root: runGit(project.dir, 'rev-parse', '--show-toplevel'), files: ['src/app.ts'] });

    const report = reportOf(project);
    expect(row(report, 'alpha')).toMatchObject({ selected: true, status: 'passed' });
    for (const title of ['beta', 'gamma']) {
      const left = row(report, title);
      expect(left.selected).toBe(false);
      expect(left.attempts).toEqual([]);
      expect(left.skip).toEqual({ cause: 'filtered', filter: 'areas', reason: `the diff misses ${title}` });
    }
    expect(report.run.filters).toEqual([{ name: 'areas', candidates: 3, excluded: 2 }]);
    expect(report.run.changes).toEqual({ base, files: 1 });
    assertValidReport(outcome.report);

    // Collection, then the change, then the filter as its own setup step
    // narrating through notices, then its summary, and only then the plan.
    const plan = events.indexOf('plan');
    expect(plan).toBeGreaterThan(0);
    expect(events.slice(0, plan + 1)).toEqual([
      'run-started',
      'setup:collect:started',
      'setup:collect:finished',
      `notice:filter:judging 1 file changed since ${base.slice(0, 7)}`,
      'setup:filter(areas):started',
      'notice:filter:areas: judging 3 tests',
      'setup:filter(areas):finished',
      'notice:filter:areas kept 1 of 3 tests, left out 2',
      'plan',
    ]);
  });

  it('runs the filters in config order, each on what the one before kept, and records both', async () => {
    const project = fixture(THREE_TESTS);
    const seen: string[][] = [];
    /** `keepOnly` that also records the titles it was given. */
    const watching = (name: string, keep: readonly string[]): TestFilter => ({
      name,
      filter: (tests, context) => {
        seen.push(tests.map(titleOf));
        return keepOnly(name, keep).filter(tests, context);
      },
    });
    const outcome = await runExisting(project, { config: { filters: [watching('areas', ['alpha', 'beta']), watching('jev', ['beta'])] } });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(seen).toEqual([['alpha', 'beta', 'gamma'], ['alpha', 'beta']]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['beta']);
    expect(row(report, 'gamma').skip?.filter).toBe('areas');
    expect(row(report, 'alpha').skip?.filter).toBe('jev');
    expect(report.run.filters).toEqual([
      { name: 'areas', candidates: 3, excluded: 1 },
      { name: 'jev', candidates: 2, excluded: 1 },
    ]);
  });

  it('skips every filter with noFilter, through run() and list() on the runner and the public e2e/runner API', async () => {
    const project = fixture(THREE_TESTS);
    let calls = 0;
    const counting: TestFilter = {
      name: 'areas',
      filter: (tests, context) => {
        calls += 1;
        return keepOnly('areas', ['alpha']).filter(tests, context);
      },
    };
    const config = { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], filters: [counting] } satisfies E2EConfig;

    const skipped = await runExisting(project, { config: { filters: [counting] }, runOptions: { noFilter: true } });
    expect(skipped.report.run.errors).toEqual([]);
    expect(skipped.exitCode).toBe(0);
    expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
    expect(reportOf(project).run.filters).toBeUndefined();
    expect(reportOf(project).run.changes).toBeUndefined();
    expect(reportOf(project).run.results.some((result) => result.skip?.filter !== undefined)).toBe(false);

    const unfiltered = await publicRunner.run({ cwd: project.dir, config, noFilter: true, changedSince: 'main' });
    expect(unfiltered.exitCode).toBe(0);
    expect(executedTests(unfiltered.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(unfiltered.report.run.filters).toBeUndefined();
    const listedAll = await publicRunner.list({ cwd: project.dir, config, env: LOCAL_ENV, noFilter: true, changedSince: 'main' });
    expect(listedAll.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.title)).toEqual(['alpha', 'beta', 'gamma']);
    expect(Object.keys(listedAll)).toEqual(['pairs', 'unmatched', 'targets']);
    expect(calls).toBe(0);

    // The same calls without noFilter apply the filter.
    const filtered = await publicRunner.run({ cwd: project.dir, config, changedSince: 'main' });
    expect(filtered.exitCode).toBe(0);
    expect(executedTests(filtered.report)).toEqual(['alpha']);
    expect(filtered.report.run.filters).toEqual([expect.objectContaining({ name: 'areas', candidates: 3, excluded: 2 })]);
    assertValidReport(filtered.report);
    const listed = await publicRunner.list({ cwd: project.dir, config, env: LOCAL_ENV, changedSince: 'main' });
    expect(listed.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.title)).toEqual(['alpha']);
    expect(listed.pairs.find((pair) => pair.title === 'beta')).toMatchObject({ disposition: 'filtered', filter: 'areas', reason: 'the diff misses beta' });
    expect(Object.keys(listed)).toEqual(['pairs', 'unmatched', 'targets']);
    expect(calls).toBe(2);
  });

  it('applies the filters to a positional run on the CLI with --changed-since, and --no-filter runs the named file whole without calling them', () => {
    const project = fixture({
      ...THREE_TESTS,
      'e2e.config.ts': cliConfig(`[
    { name: 'areas', filter(tests, { projectRoot }) {
      appendFileSync(path.join(projectRoot, 'given.log'), JSON.stringify(tests.map((test) => test.titlePath.at(-1))) + '\\n');
      return { exclude: Object.fromEntries(tests.filter((test) => test.titlePath.at(-1) !== 'alpha').map((test) => [test.id, 'the diff misses ' + test.titlePath.at(-1)])) };
    } },
  ]`),
    });
    const given = path.join(project.dir, 'given.log');
    /** The candidate titles each filter call was given since the last read, then clears the log. */
    const takeGiven = (): string[][] => {
      if (!existsSync(given)) return [];
      const lines = readFileSync(given, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      rmSync(given);
      return lines;
    };

    const all = cli(project, ['run', '--changed-since', 'main']);
    expect(all.exitCode, all.output).toBe(0);
    expect(takeGiven()).toEqual([['alpha', 'beta', 'gamma']]);
    expect(executedTests(reportOf(project))).toEqual(['alpha']);

    const everything = cli(project, ['run', '--changed-since', 'main', '--no-filter']);
    expect(everything.exitCode, everything.output).toBe(0);
    expect(takeGiven()).toEqual([]);
    expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
    expect(reportOf(project).run.filters).toBeUndefined();

    // A positional narrows what the filter is given; the filter still decides, and leaving it empty passes.
    const positional = cli(project, ['run', 'tests/beta.e2e.ts', '--changed-since', 'main']);
    expect(positional.exitCode, positional.output).toBe(0);
    expect(takeGiven()).toEqual([['beta']]);
    let report = reportOf(project);
    expect(executedTests(report)).toEqual([]);
    expect(row(report, 'beta').skip).toEqual({ cause: 'filtered', filter: 'areas', reason: 'the diff misses beta' });
    expect(report.run.filters).toEqual([expect.objectContaining({ name: 'areas', candidates: 1, excluded: 1 })]);

    const named = cli(project, ['run', 'tests/beta.e2e.ts', '--changed-since', 'main', '--no-filter']);
    expect(named.exitCode, named.output).toBe(0);
    expect(takeGiven()).toEqual([]);
    report = reportOf(project);
    expect(executedTests(report)).toEqual(['beta']);
    expect(report.run.filters).toBeUndefined();
  });

  it('repeats only what the filters kept, after they decided, and records a left-out test once', async () => {
    const project = fixture(THREE_TESTS);
    const given: string[][] = [];
    const outcome = await runExisting(project, {
      config: {
        filters: [{ name: 'areas', filter: (tests, context) => { given.push(tests.map(titleOf)); return keepOnly('areas', ['alpha']).filter(tests, context); } }],
      },
      runOptions: { repeatEach: 3 },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    // The filter judged each test once, never a repeat.
    expect(given).toEqual([['alpha', 'beta', 'gamma']]);
    const report = reportOf(project);
    /** Each row of the test titled `title`: its repeat, whether it ran, and the filter that left it out. */
    const rows = (title: string) =>
      report.run.results.filter((result) => result.titlePath.at(-1) === title).map((result) => [result.repeat, result.selected, result.skip?.filter]);
    expect(rows('alpha')).toEqual([[0, true, undefined], [1, true, undefined], [2, true, undefined]]);
    expect(rows('beta')).toEqual([[0, false, 'areas']]);
    expect(rows('gamma')).toEqual([[0, false, 'areas']]);
    expect(report.run.filters).toEqual([{ name: 'areas', candidates: 3, excluded: 2 }]);
  });

  it('never calls a filter on the tests run({ tests }) brings, as e2e explore runs them', async () => {
    const project = fixture(THREE_TESTS);
    let called = false;
    const throwing: TestFilter = {
      name: 'areas',
      filter: () => {
        called = true;
        throw new Error('a filter judged an exploration');
      },
    };
    const registration: ModuleRegistration = {
      tests: [
        {
          kind: 'test',
          title: 'explore the app',
          titlePath: ['explore the app'],
          declarationIndex: 0,
          options: {},
          sessions: [],
          tags: [],
          fn: async () => undefined,
          fixtures: [],
          group: undefined,
          mode: 'normal',
          source: undefined,
        },
      ],
      hooks: [],
    };
    const outcome = await runExisting(project, { config: { filters: [throwing] }, runOptions: { tests: { file: 'explore', registration } } });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(called).toBe(false);
    expect(outcome.report.run.results.map((result) => [result.titlePath.at(-1), result.status])).toEqual([['explore the app', 'passed']]);
    expect(outcome.report.run.filters).toBeUndefined();
    expect(outcome.report.run.changes).toBeUndefined();
  });

  it('refuses two filters with one name at config load, before any test file loads', () => {
    const project = fixture({
      'tests/alpha.e2e.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../collected', import.meta.url), '');\n${testFile('alpha')}`,
      'e2e.config.ts': cliConfig(`[
    { name: 'jev', filter: () => ({ exclude: {} }) },
    { name: 'areas', filter: () => ({ exclude: {} }) },
    { name: 'jev', filter: () => ({ exclude: {} }) },
  ]`),
    });
    const marker = path.join(project.dir, 'collected');
    for (const args of [['run'], ['run', '--no-filter'], ['list']]) {
      const refused = cli(project, args);
      expect(refused.exitCode, args.join(' ')).toBe(2);
      expect(refused.output).toContain('INVALID_CONFIG');
      expect(refused.output).toContain('filters has two filters named "jev"; the report tells filters apart by name');
      expect(existsSync(marker)).toBe(false);
    }
    expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
  });

  it('passes a run the filter leaves empty without preparing an engine or starting the app, and still reports it', async () => {
    const project = fixture({ ...THREE_TESTS, ...STARTUP_SCRIPTS });
    const stale = path.join(project.dir, '.e2e', 'results', 'stale-test');
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, 'trace.md'), 'from an earlier run\n');
    const events: string[] = [];
    const outcome = await runExisting(project, {
      config: { targets: [await markedTarget(project.dir)], filters: [keepOnly('areas', [])] },
      runOptions: { onEvent: (event) => { events.push(describeEvent(event)); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');
    expect(existsSync(path.join(project.dir, 'prepared'))).toBe(false);
    expect(existsSync(path.join(project.dir, 'startup.log'))).toBe(false);
    expect(events).toContain('notice:filter:areas left out all 3 tests');
    expect(events).toContain(`notice:filter:judging 1 file changed since ${baseOf(project).slice(0, 7)}`);
    expect(events).toContain('plan');
    expect(events.filter((event) => event.startsWith('setup:') && !/^setup:(collect|filter)/.test(event))).toEqual([]);
    // The run still began: the earlier evidence is gone and this report replaced it.
    expect(existsSync(stale)).toBe(false);
    const report = reportOf(project);
    expect(report.run.status).toBe('passed');
    expect(report.run.results.map((result) => result.selected)).toEqual([false, false, false]);
    expect(report.run.results.every((result) => result.skip?.filter === 'areas')).toBe(true);
    expect(report.run.filters).toEqual([expect.objectContaining({ name: 'areas', candidates: 3, excluded: 3 })]);
  });

  it('passes an empty selection under passWithNoTests the same way, preparing and starting nothing', async () => {
    const project = fixture({ ...THREE_TESTS, ...STARTUP_SCRIPTS });
    const outcome = await runExisting(project, {
      config: { targets: [await markedTarget(project.dir)] },
      runOptions: { tags: ['nope'], passWithNoTests: true },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(path.join(project.dir, 'prepared'))).toBe(false);
    expect(existsSync(path.join(project.dir, 'startup.log'))).toBe(false);
    const report = reportOf(project);
    expect(report.run.results.map((result) => result.selected)).toEqual([false, false, false]);
    expect(report.run.filters).toBeUndefined();

    // The markers are real: the same target with work to do prepares its engine and starts its app.
    const ran = await runExisting(project, { config: { targets: [await markedTarget(project.dir)] } });
    expect(ran.report.run.errors).toEqual([]);
    expect(ran.exitCode).toBe(0);
    expect(existsSync(path.join(project.dir, 'prepared'))).toBe(true);
    expect(readFileSync(path.join(project.dir, 'startup.log'), 'utf8')).toBe('app\n');
  });

  it('calls no filter when the other flags left nothing to judge under passWithNoTests', async () => {
    const project = fixture({ ...THREE_TESTS, ...STARTUP_SCRIPTS });
    let called = false;
    const events: string[] = [];
    const outcome = await runExisting(project, {
      config: {
        targets: [await markedTarget(project.dir)],
        filters: [{ name: 'areas', filter: () => { called = true; return { exclude: {} }; } }],
      },
      runOptions: { tags: ['nope'], passWithNoTests: true, onEvent: (event) => { events.push(describeEvent(event)); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(called).toBe(false);
    expect(events).toContain('notice:filter:no tests to judge, so no filter ran');
    expect(events.some((event) => event.startsWith('setup:filter'))).toBe(false);
    expect(existsSync(path.join(project.dir, 'prepared'))).toBe(false);
    expect(existsSync(path.join(project.dir, 'startup.log'))).toBe(false);
    expect(reportOf(project).run.filters).toBeUndefined();
    expect(reportOf(project).run.changes).toEqual({ files: 0, skipped: 'no tests to judge' });
  });

  it('fails the run before it starts when a filter throws, names an id no collected test has, or throws a configuration error, keeping the last report', () => {
    const project = fixture({
      ...THREE_TESTS,
      'e2e.config.ts': cliConfig(`[
    { name: 'boom', filter() { if (process.env.FILTER_MODE === 'boom') throw new Error('kaboom'); return { exclude: {} }; } },
    { name: 'typo', filter: (tests) => ({ exclude: process.env.FILTER_MODE === 'typo' ? { [tests[0]!.id + 'x']: 'mistyped' } : {} }) },
    { name: 'strict', filter() { if (process.env.FILTER_MODE === 'strict') throw new ConfigurationError('INVALID_CONFIG', 'the areas map is empty'); return { exclude: {} }; } },
  ]`),
    });
    expect(cli(project, ['run', '--changed-since', 'main']).exitCode).toBe(0);
    const previous = reportBytes(project);
    expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
    expect(reportOf(project).run.filters?.map((record) => record.name)).toEqual(['boom', 'typo', 'strict']);

    const thrown = cli(project, ['run', '--changed-since', 'main'], { FILTER_MODE: 'boom' });
    expect(thrown.exitCode).toBe(3);
    expect(thrown.output).toContain('FILTER_FAILED');
    expect(thrown.output).toContain('filter "boom" failed: kaboom');
    expect(reportBytes(project)).toBe(previous);

    const stranger = cli(project, ['run', '--changed-since', 'main'], { FILTER_MODE: 'typo' });
    expect(stranger.exitCode).toBe(3);
    expect(stranger.output).toContain('FILTER_FAILED');
    expect(stranger.output).toContain('filter "typo" returned an invalid result: exclude names "tests/alpha.e2e.ts::alphax", which no collected test has; exclude takes test.id');
    expect(reportBytes(project)).toBe(previous);

    const configuration = cli(project, ['run', '--changed-since', 'main'], { FILTER_MODE: 'strict' });
    expect(configuration.exitCode).toBe(2);
    expect(configuration.output).toContain('INVALID_CONFIG');
    expect(configuration.output).toContain('filter "strict": the areas map is empty');
    expect(configuration.output).not.toContain('FILTER_FAILED');
    expect(reportBytes(project)).toBe(previous);

    // --no-filter steps around a broken filter.
    const around = cli(project, ['run', '--changed-since', 'main', '--no-filter'], { FILTER_MODE: 'boom' });
    expect(around.exitCode, around.output).toBe(0);
    expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('when the filters run', () => {
  /** A filter that counts its calls and leaves out every test titled in `leave`. */
  function counting(name: string, leave: readonly string[] = []) {
    const calls: string[][] = [];
    const filter: TestFilter = {
      name,
      filter: (tests) => {
        calls.push(tests.map(titleOf));
        return { exclude: Object.fromEntries(tests.filter((test) => leave.includes(titleOf(test))).map((test) => [test.id, 'unaffected'])) };
      },
    };
    return { filter, calls };
  }

  it('calls no filter without a change, running every test and saying why, on run and list', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = counting('areas', ['beta']);
    const events: string[] = [];
    const outcome = await runExisting(project, {
      config: { filters: [filter] },
      runOptions: { changedSince: undefined, onEvent: (event) => { events.push(describeEvent(event)); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(calls).toEqual([]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.changes).toEqual({ files: 0, skipped: 'not a pull request' });
    expect(report.run.filters).toBeUndefined();
    expect(events.filter((event) => event.startsWith('notice:filter'))).toEqual(['notice:filter:not a pull request, so no filter ran']);

    const listed = await listExisting(project, { config: { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }], filters: [filter] }, changedSince: undefined });
    expect(listed.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    expect(calls).toEqual([]);
  });

  it('judges a GitHub pull request from the base its event names, and warns and runs every test when the checkout lacks it', async () => {
    const project = fixture(THREE_TESTS);
    const base = baseOf(project);
    /** A pull_request run whose event payload names `sha` as the base. */
    const pullRequest = (sha: string): NodeJS.ProcessEnv => {
      const eventPath = path.join(project.dir, `event-${sha.slice(0, 7)}.json`);
      writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha } } }));
      return { ...LOCAL_ENV, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_BASE_REF: 'main' };
    };
    const seen: TestFilterContext['changes'][] = [];
    const areas: TestFilter = { name: 'areas', filter: (tests, context) => { seen.push(context.changes); return keepOnly('areas', ['alpha']).filter(tests, context); } };

    const judged = await runExisting(project, { config: { filters: [areas] }, runOptions: { changedSince: undefined, env: pullRequest(base) } });
    expect(judged.report.run.errors).toEqual([]);
    expect(seen).toEqual([expect.objectContaining({ base, files: ['src/app.ts'] })]);
    expect(executedTests(reportOf(project))).toEqual(['alpha']);
    expect(reportOf(project).run.changes).toEqual({ base, files: 1 });

    const missing = 'f'.repeat(40);
    const notices: string[] = [];
    const shallow = await runExisting(project, {
      config: { filters: [areas] },
      runOptions: { changedSince: undefined, env: pullRequest(missing), onEvent: (event) => { if (event.type === 'notice') notices.push(event.message); } },
    });
    expect(shallow.report.run.errors).toEqual([]);
    expect(shallow.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    const reason = "could not find the pull request's base commit fffffff in the checkout: check out with fetch-depth: 0";
    expect(notices).toContain(`warning: no filter ran: ${reason}`);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.changes).toEqual({ files: 0, skipped: reason });
  });

  it('runs every test without calling a filter when a lockfile changed', async () => {
    const project = fixture(THREE_TESTS, { 'packages/ui/pnpm-lock.yaml': 'lockfileVersion: 9\n', 'src/app.ts': 'export const version = 2;\n' });
    const { filter, calls } = counting('areas', ['alpha', 'beta', 'gamma']);
    const outcome = await runExisting(project, { config: { filters: [filter] } });
    expect(outcome.exitCode).toBe(0);
    expect(calls).toEqual([]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.changes).toEqual({ base: baseOf(project), files: 2, skipped: 'packages/ui/pnpm-lock.yaml changed' });
  });

  it('runs every test without calling a filter when the config file the run loaded changed', () => {
    const config = cliConfig(`[
    { name: 'areas', filter(tests, { projectRoot }) {
      appendFileSync(path.join(projectRoot, 'given.log'), JSON.stringify(tests.map((test) => test.title)) + '\\n');
      return { exclude: Object.fromEntries(tests.map((test) => [test.id, 'unaffected'])) };
    } },
  ]`);
    const project = fixture({ ...THREE_TESTS, 'e2e.config.ts': config }, { 'e2e.config.ts': `${config}// retries next\n` });
    const ran = cli(project, ['run', '--changed-since', 'main']);
    expect(ran.exitCode, ran.output).toBe(0);
    expect(ran.output).toContain('e2e.config.ts changed, so no filter ran');
    expect(existsSync(path.join(project.dir, 'given.log'))).toBe(false);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.changes).toEqual({ base: baseOf(project), files: 1, skipped: 'e2e.config.ts changed' });
  });

  it('never hands a filter a test whose file changed: it runs, and the report counts it', async () => {
    const project = fixture(THREE_TESTS, { 'tests/beta.e2e.ts': `${testFile('beta')}// edited\n`, 'src/app.ts': 'export const version = 2;\n' });
    const { filter, calls } = counting('areas', ['alpha', 'beta', 'gamma']);
    const notices: string[] = [];
    const outcome = await runExisting(project, {
      config: { filters: [filter] },
      runOptions: { onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(outcome.exitCode).toBe(0);
    expect(calls).toEqual([['alpha', 'gamma']]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['beta']);
    expect(report.run.changes).toEqual({ base: baseOf(project), files: 2, pinned: 1 });
    expect(notices).toEqual([
      `judging 2 files changed since ${baseOf(project).slice(0, 7)}`,
      '1 test runs without filters: its test or setup file changed',
      'areas left out all 2 tests',
    ]);
  });

  it('runs a changed setup and every test that uses its session without asking the filters, though a filter would leave out every test', async () => {
    /** The setup file, with `edit` as its last line. */
    const setupFile = (edit: string) => `import { test } from 'e2e';
test.setup('sign in', { sessions: ['member'] }, async ({ app, session }) => {
  await app.open();
  await session.save('member');
});
${edit}
`;
    const project = fixture(
      { 'tests/auth.setup.e2e.ts': setupFile(''), 'tests/member.e2e.ts': testFile('member page', "{ session: 'member' }"), 'tests/guest.e2e.ts': testFile('guest page') },
      { 'tests/auth.setup.e2e.ts': setupFile('// a new sign-in form') },
    );
    const { filter, calls } = counting('areas', ['member page', 'guest page']);
    const notices: string[] = [];
    const outcome = await runExisting(project, {
      config: { filters: [filter] },
      runOptions: { onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(calls).toEqual([['guest page']]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['member page']);
    expect(row(report, 'sign in')).toMatchObject({ selected: true, status: 'passed' });
    expect(row(report, 'guest page').skip).toEqual({ cause: 'filtered', filter: 'areas', reason: 'unaffected' });
    expect(report.run.changes).toEqual({ base: baseOf(project), files: 1, pinned: 1 });
    expect(notices).toEqual([
      `judging 1 file changed since ${baseOf(project).slice(0, 7)}`,
      '1 test runs without filters: its test or setup file changed',
      'areas left out all 1 test',
    ]);

    const listed = await listExisting(project, { config: { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], filters: [filter] } });
    expect(listed.pairs.filter((pair) => pair.disposition === 'run').map((pair) => pair.title).toSorted()).toEqual(['member page', 'sign in']);
  });

  it('reruns what --last-failed owes without asking the filters, so a filter cannot turn a real failure green', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/beta.e2e.ts': `import { test } from 'e2e';\ntest('beta', async () => { throw new Error('beta broke'); });\n` });
    let call = 0;
    const drifting: TestFilter = {
      name: 'jev',
      filter: (tests) => {
        call += 1;
        // The first call keeps beta; asked again about beta alone, it would leave it out.
        const leave = call === 1 ? tests.filter((test) => titleOf(test) === 'gamma') : tests;
        return { exclude: Object.fromEntries(leave.map((test) => [test.id, 'Jev: 5% likely affected'])) };
      },
    };
    const first = await runExisting(project, { config: { filters: [drifting] } });
    expect(first.exitCode).toBe(1);
    expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta']);

    const notices: string[] = [];
    const rerun = await runExisting(project, {
      config: { filters: [drifting] },
      runOptions: { lastFailed: true, onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(call).toBe(1);
    expect(rerun.exitCode).toBe(1);
    expect(rerun.status).toBe('failed');
    const report = reportOf(project);
    expect(row(report, 'beta')).toMatchObject({ selected: true, status: 'failed' });
    expect(report.run.changes).toEqual({ files: 0, skipped: '--last-failed' });
    expect(report.run.filters).toBeUndefined();
    expect(notices).toEqual(['--last-failed: the tests the last run owes run without filters']);
  });

  it('abandons a filter past the deadline, runs every test it was given, and passes, recording timedOut', async () => {
    const project = fixture(THREE_TESTS);
    const notices: string[] = [];
    const finished: { readonly name: string; readonly outcome: string | undefined }[] = [];
    const slow: TestFilter = {
      name: 'slow',
      filter: (_tests, { log }) => {
        log('asking the model about 3 tests');
        return new Promise(() => undefined);
      },
    };
    const outcome = await runExisting(project, {
      config: { filters: [slow, keepOnly('areas', ['alpha', 'beta'])] },
      runOptions: {
        filterTimeout: 50,
        onEvent: (event) => {
          if (event.type === 'notice' && event.target === 'filter') notices.push(event.message);
          if (event.type === 'setup' && event.step.kind === 'filter' && event.state === 'finished') finished.push({ name: event.step.name, outcome: event.outcome });
        },
      },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta']);
    expect(report.run.filters).toEqual([
      { name: 'slow', candidates: 3, excluded: 0, note: 'did not finish within 50ms: running every test it was given', timedOut: true },
      { name: 'areas', candidates: 3, excluded: 1 },
    ]);
    expect(notices).toEqual([
      `judging 1 file changed since ${baseOf(project).slice(0, 7)}`,
      'slow: asking the model about 3 tests',
      'warning: slow did not finish within 50ms: running every test it was given',
      'areas kept 2 of 3 tests, left out 1',
    ]);
    // The step that timed out never reads as done.
    expect(finished).toEqual([{ name: 'slow', outcome: 'timed out' }, { name: 'areas', outcome: undefined }]);
  });

  it('fails an empty selection with NO_TESTS before asking git or calling a filter, on run and list', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = counting('areas');
    // A ref git cannot measure from proves git was never asked.
    const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { grep: [/nothing/], changedSince: 'nope' } });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'NO_TESTS', phase: 'collection' })]);
    expect(outcome.report.run.changes).toBeUndefined();
    const listing = listExisting(project, {
      config: { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }], filters: [filter] },
      grep: [/nothing/],
      changedSince: 'nope',
    });
    await expect(listing).rejects.toMatchObject({ code: 'NO_TESTS' });
    expect(calls).toEqual([]);
  });

  it('never asks git for the change when no filter would run: with noFilter or with no filters configured, on run and list', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = counting('areas', ['alpha']);
    const targets = [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }];
    for (const [filters, noFilter] of [[[filter], true], [[], false]] as const) {
      const outcome = await runExisting(project, { config: { filters }, runOptions: { changedSince: 'nope', noFilter } });
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(0);
      expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
      const listed = await listExisting(project, { config: { targets, filters }, changedSince: 'nope', noFilter });
      expect(listed.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    }
    expect(calls).toEqual([]);
  });

  it('is INVALID_CHANGED_SINCE, exit 2, for a changedSince that is not a string, on run and list', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = counting('areas');
    const changedSince = true as unknown as string;
    const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince } });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.run.errors).toEqual([expect.objectContaining({ category: 'configuration', code: 'INVALID_CHANGED_SINCE', phase: 'config' })]);
    const targets = [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }];
    await expect(listExisting(project, { config: { targets, filters: [filter] }, changedSince })).rejects.toMatchObject({ code: 'INVALID_CHANGED_SINCE' });
    expect(calls).toEqual([]);
  });

  it('ignores a collected test a filter names but was not given, whose fate stands, and fails on an id no collected test has', async () => {
    /** A filter that leaves out the test titled `title`, found by renaming the first test it is given. */
    const naming = (name: string, from: string, title: string): TestFilter => ({
      name,
      filter: (tests) => ({ exclude: { [tests[0]!.id.replaceAll(from, title)]: 'unaffected' } }),
    });

    // Outside the shard: gamma keeps the shard's reason.
    const sharded = fixture(THREE_TESTS);
    const shard = await runExisting(sharded, { config: { filters: [naming('areas', 'alpha', 'gamma')] }, runOptions: { shard: { index: 1, total: 2 } } });
    expect(shard.report.run.errors).toEqual([]);
    expect(shard.exitCode).toBe(0);
    let report = reportOf(sharded);
    expect(executedTests(report)).toEqual(['alpha', 'beta']);
    expect(row(report, 'gamma').skip).toEqual({ cause: 'filtered', reason: 'outside the shard' });
    expect(report.run.filters).toEqual([{ name: 'areas', candidates: 2, excluded: 0 }]);

    // In a changed test file: beta runs.
    const edited = fixture(THREE_TESTS, { 'tests/beta.e2e.ts': `${testFile('beta')}// edited\n`, 'src/app.ts': 'export const version = 2;\n' });
    const pinned = await runExisting(edited, { config: { filters: [naming('areas', 'alpha', 'beta')] } });
    expect(pinned.report.run.errors).toEqual([]);
    expect(pinned.exitCode).toBe(0);
    report = reportOf(edited);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.filters).toEqual([{ name: 'areas', candidates: 2, excluded: 0 }]);

    // Left out by an earlier filter: alpha keeps that filter's reason.
    const chained = fixture(THREE_TESTS);
    const twice = await runExisting(chained, { config: { filters: [keepOnly('areas', ['beta', 'gamma']), naming('jev', 'beta', 'alpha')] } });
    expect(twice.report.run.errors).toEqual([]);
    expect(twice.exitCode).toBe(0);
    report = reportOf(chained);
    expect(executedTests(report)).toEqual(['beta', 'gamma']);
    expect(row(report, 'alpha').skip).toEqual({ cause: 'filtered', filter: 'areas', reason: 'the diff misses alpha' });

    // No collected test has the id: the run fails before it starts.
    const unknown = await runExisting(chained, { config: { filters: [naming('typo', 'alpha', 'nobody')] } });
    expect(unknown.exitCode).toBe(3);
    expect(unknown.report.run.errors).toEqual([
      expect.objectContaining({
        code: 'FILTER_FAILED',
        phase: 'filter',
        message: 'filter "typo" returned an invalid result: exclude names "tests/nobody.e2e.ts::nobody", which no collected test has; exclude takes test.id',
      }),
    ]);
  });

  it('is INVALID_CHANGED_SINCE, exit 2, for a ref git cannot measure from, and FILTER_FAILED a failure of the filter phase', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = counting('areas');
    const unknown = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince: 'origin/mian' } });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.report.run.errors).toEqual([
      expect.objectContaining({ category: 'configuration', code: 'INVALID_CHANGED_SINCE', phase: 'filter', message: '--changed-since "origin/mian" names no commit in this checkout' }),
    ]);
    expect(calls).toEqual([]);

    const broken: TestFilter = { name: 'boom', filter: () => { throw new Error('kaboom'); } };
    const failed = await runExisting(project, { config: { filters: [broken] } });
    expect(failed.exitCode).toBe(3);
    expect(failed.report.run.errors).toEqual([expect.objectContaining({ code: 'FILTER_FAILED', phase: 'filter' })]);
    assertValidReport(failed.report);

    // A refused answer fails the filter's step as a throw does: it never reads finished.
    const events: string[] = [];
    const refused: TestFilter = { name: 'typo', filter: (tests) => ({ exclude: { [`${tests[0]!.id}x`]: 'mistyped' } }) };
    const refusedRun = await runExisting(project, { config: { filters: [refused] }, runOptions: { onEvent: (event) => { events.push(describeEvent(event)); } } });
    expect(refusedRun.exitCode).toBe(3);
    expect(refusedRun.report.run.errors).toEqual([expect.objectContaining({ code: 'FILTER_FAILED', phase: 'filter' })]);
    expect(events.filter((event) => event.startsWith('setup:filter'))).toEqual(['setup:filter(typo):started']);

    const listed = cli(fixture({ ...THREE_TESTS, 'e2e.config.ts': cliConfig("[{ name: 'areas', filter: () => ({ exclude: {} }) }]") }), ['list', '--changed-since', 'nope']);
    expect(listed.exitCode).toBe(2);
    expect(listed.output).toContain('INVALID_CHANGED_SINCE');
    expect(listed.output).toContain('--changed-since "nope" names no commit in this checkout');
  });
});

describe('what a filter is told', () => {
  it('hands a project reached through a symlink its resolved root, so its test files join the change root', async () => {
    const project = fixture(THREE_TESTS);
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-filter-link-')), 'project');
    symlinkSync(project.dir, link);
    try {
      let joined: string[] = [];
      const areas: TestFilter = {
        name: 'areas',
        filter: (tests, { projectRoot, changes }) => {
          joined = tests.map((test) => path.relative(changes.root, path.join(projectRoot, test.file)).split(path.sep).join('/'));
          return { exclude: {} };
        },
      };
      const targets = [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }];
      await listExisting(project, { cwd: link, config: { targets, filters: [areas] } });
      expect(joined).toEqual(['tests/alpha.e2e.ts', 'tests/beta.e2e.ts', 'tests/gamma.e2e.ts']);
    } finally {
      rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  it.runIf(CASE_INSENSITIVE)('pins a changed test file and hands the root as on disk when the project is reached in another case', async () => {
    const project = fixture(THREE_TESTS, { 'tests/alpha.e2e.ts': `${testFile('alpha')}// edited\n` });
    const shouted = path.join(path.dirname(project.dir), path.basename(project.dir).toUpperCase());
    let joined: string[] = [];
    const areas: TestFilter = {
      name: 'areas',
      filter: (tests, { projectRoot, changes }) => {
        joined = tests.map((test) => path.relative(changes.root, path.join(projectRoot, test.file)).split(path.sep).join('/'));
        return { exclude: {} };
      },
    };
    const targets = [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }];
    const listed = await listExisting(project, { cwd: shouted, config: { targets, filters: [areas] } });
    // alpha changed, so it runs without the filter, which is given the rest.
    expect(listed.pairs.map((pair) => [pair.title, pair.disposition])).toEqual([['alpha', 'run'], ['beta', 'run'], ['gamma', 'run']]);
    expect(joined).toEqual(['tests/beta.e2e.ts', 'tests/gamma.e2e.ts']);
  });

  it('counts what a filter left out in tests on several targets, while the report lists a row per test and target', async () => {
    const project = fixture(THREE_TESTS);
    const notices: string[] = [];
    const targets = ['fake', 'fake-2'].map((name) => ({ name, platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }));
    const outcome = await runExisting(project, {
      config: { targets, filters: [keepOnly('areas', ['alpha'])] },
      runOptions: { onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(notices).toContain('areas kept 1 of 3 tests, left out 2');
    expect(reportOf(project).run.results.filter((result) => result.skip?.filter === 'areas')).toHaveLength(4);
  });
});

describe('interrupting a filter that ignores its signal', () => {
  /** A filter that marks when it started, then waits a minute without listening to its signal. */
  const HANGING = `[
    { name: 'slow', async filter() {
      writeFileSync(new URL('./filter-started', import.meta.url), '');
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return { exclude: {} };
    } },
  ]`;

  it('exits the CLI with 130 at once on Ctrl-C and writes no report', async () => {
    const project = fixture({ ...THREE_TESTS, 'e2e.config.ts': cliConfig(HANGING) });
    const child = spawn(process.execPath, [CLI, 'run', '--changed-since', 'main'], {
      cwd: project.dir,
      env: { ...LOCAL_ENV, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      await waitUntil(() => existsSync(path.join(project.dir, 'filter-started')), 30_000);
      const sentAt = Date.now();
      child.kill('SIGINT');
      const { code, signal } = await exited;
      const elapsed = Date.now() - sentAt;
      expect({ code, signal }, output).toEqual({ code: 130, signal: null });
      expect(elapsed).toBeLessThan(2_000);
      expect(output).not.toContain('FILTER_FAILED');
      expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('writes all of its output before it exits on Ctrl-C, even to a reader that fell behind', async () => {
    const project = fixture({
      ...THREE_TESTS,
      'e2e.config.ts': cliConfig(`[
    { name: 'slow', async filter() {
      writeFileSync(new URL('./filter-started', import.meta.url), '');
      for (let line = 0; line < 20_000; line += 1) console.log('diff line ' + String(line).padStart(5, '0') + ' ' + 'x'.repeat(40));
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return { exclude: {} };
    } },
  ]`),
    });
    const child = spawn(process.execPath, [CLI, 'run', '--changed-since', 'main'], {
      cwd: project.dir,
      env: { ...LOCAL_ENV, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Nothing reads stdout until the CLI was told to stop, so its pipe backs up
    // meanwhile. A `readable` listener, not a pause, holds it: Node resumes a
    // paused child stream, dropping what it holds, once the child exits.
    const chunks: Buffer[] = [];
    let reading = false;
    /** Takes what stdout holds, once the test reads it. */
    const take = (): void => {
      if (!reading) return;
      for (let chunk = child.stdout.read() as Buffer | null; chunk !== null; chunk = child.stdout.read() as Buffer | null) chunks.push(chunk);
    };
    child.stdout.on('readable', take);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const closed = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code));
    });
    try {
      await waitUntil(() => existsSync(path.join(project.dir, 'filter-started')), 30_000);
      child.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      reading = true;
      take();
      expect(await closed, stderr).toBe(130);
      const stdout = Buffer.concat(chunks).toString();
      expect(stdout).toContain(`diff line 19999 ${'x'.repeat(40)}`);
      expect(stdout).toContain('interrupted while running filter "slow"');
      expect(stdout.trimEnd().split('\n').at(-1)).toMatch(/Report\s+\(not written\)/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('ends a run() interrupted, recording no error and writing no report', async () => {
    const project = fixture(THREE_TESTS);
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const outcome = await runExisting(project, {
      config: {
        filters: [
          {
            name: 'slow',
            filter(_tests, { signal }) {
              seen = signal;
              setTimeout(() => controller.abort(), 50);
              return new Promise(() => undefined);
            },
          },
        ],
      },
      runOptions: { interruptSignal: controller.signal },
    });
    expect(outcome.status).toBe('interrupted');
    expect(outcome.exitCode).toBe(130);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.results).toEqual([]);
    expect(seen?.aborted).toBe(true);
    assertValidReport(outcome.report);
    expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
  });

  it('ends the public run() interrupted on its interruptSignal', async () => {
    const project = fixture(THREE_TESTS);
    const controller = new AbortController();
    const outcome = await publicRunner.run({
      cwd: project.dir,
      config: {
        targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }],
        filters: [
          {
            name: 'slow',
            filter() {
              setTimeout(() => controller.abort(), 50);
              return new Promise(() => undefined);
            },
          },
        ],
      },
      interruptSignal: controller.signal,
      changedSince: 'main',
    });
    expect(outcome.status).toBe('interrupted');
    expect(outcome.exitCode).toBe(130);
    expect(outcome.report.run.errors).toEqual([]);
    expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
  });
});

describe('e2e list with filters', () => {
  it('hands the filters only the slice --shard or --grep selects, keeping each other test\'s own reason', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/delta.e2e.ts': testFile('delta') });
    const given: string[][] = [];
    const areas: TestFilter = {
      name: 'areas',
      filter: (tests, context) => {
        given.push(tests.map(titleOf));
        return keepOnly('areas', ['alpha', 'gamma']).filter(tests, context);
      },
    };
    const config = { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }], filters: [areas] };
    /** Each listed pair's title and disposition, with the filter or the reason that left it out. */
    const dispositions = (pairs: readonly ListedPair[]) => pairs.map((pair) => [pair.title, pair.disposition, pair.filter ?? pair.reason]);

    const sharded = await listExisting(project, { config, shard: { index: 1, total: 2 } });
    expect(given).toEqual([['alpha', 'beta']]);
    expect(dispositions(sharded.pairs)).toEqual([
      ['alpha', 'run', undefined],
      ['beta', 'filtered', 'areas'],
      ['delta', 'filtered', 'outside the shard'],
      ['gamma', 'filtered', 'outside the shard'],
    ]);

    const grepped = await listExisting(project, { config, grep: [/^(beta|gamma)$/] });
    expect(given.at(-1)).toEqual(['beta', 'gamma']);
    expect(dispositions(grepped.pairs)).toEqual([
      ['alpha', 'filtered', 'title does not match --grep'],
      ['beta', 'filtered', 'areas'],
      ['delta', 'filtered', 'title does not match --grep'],
      ['gamma', 'run', undefined],
    ]);
  });

  it('prints the pairs a filter left out with the filter and its reason, as json { pairs } and as lines, the summary on stderr, and starts nothing', () => {
    const project = fixture({
      ...THREE_TESTS,
      ...STARTUP_SCRIPTS,
      'e2e.config.ts': cliConfig(
        `[
    { name: 'areas', filter(tests, { log }) {
      log('asking about ' + tests.length + ' tests');
      return { exclude: Object.fromEntries(tests.filter((test) => test.titlePath.at(-1) !== 'alpha').map((test) => [test.id, 'the diff misses ' + test.titlePath.at(-1)])), note: 'only alpha changed' };
    } },
  ]`,
        {
          target: `{ name: 'fake', platform: 'fake', engine: { ...createFakeEngine().engine, async prepare() { writeFileSync(new URL('./prepared', import.meta.url), ''); } }, app: { url: 'http://127.0.0.1:1', command: { executable: process.execPath, args: ['server.cjs', '1'] } } }`,
        },
      ),
    });
    const listed = cli(project, ['list', '--reporter', 'json', '--changed-since', 'main']);
    expect(listed.exitCode, listed.output).toBe(0);
    const json = JSON.parse(listed.stdout) as { pairs: ListedPair[] };
    expect(Object.keys(json)).toEqual(['pairs']);
    expect(json.pairs.map((pair) => [pair.title, pair.disposition, pair.filter, pair.reason])).toEqual([
      ['alpha', 'run', undefined, undefined],
      ['beta', 'filtered', 'areas', 'the diff misses beta'],
      ['gamma', 'filtered', 'areas', 'the diff misses gamma'],
    ]);
    const base = baseOf(project);
    expect(listed.stderr).toBe([`judging 1 file changed since ${base.slice(0, 7)}`, 'areas: asking about 3 tests', 'areas kept 1 of 3 tests, left out 2 (only alpha changed)', ''].join('\n'));
    expect(listed.stdout).not.toContain('asking about');
    expect(existsSync(path.join(project.dir, 'prepared'))).toBe(false);
    expect(existsSync(path.join(project.dir, 'startup.log'))).toBe(false);

    const lines = cli(project, ['list', '--changed-since', 'main']);
    expect(lines.exitCode).toBe(0);
    expect(lines.stdout).toBe(
      [
        'tests/alpha.e2e.ts › alpha [fake]',
        'tests/beta.e2e.ts › beta [fake] (left out by areas: the diff misses beta)',
        'tests/gamma.e2e.ts › gamma [fake] (left out by areas: the diff misses gamma)',
        '',
      ].join('\n'),
    );
    expect(lines.stderr).toContain('areas kept 1 of 3 tests, left out 2 (only alpha changed)\n');

    const unfiltered = cli(project, ['list', '--no-filter', '--reporter', 'json']);
    expect(unfiltered.exitCode).toBe(0);
    const all = JSON.parse(unfiltered.stdout) as { pairs: ListedPair[] };
    expect(Object.keys(all)).toEqual(['pairs']);
    expect(all.pairs.map((pair) => [pair.title, pair.disposition])).toEqual([['alpha', 'run'], ['beta', 'run'], ['gamma', 'run']]);
    expect(unfiltered.stderr).toBe('');
  });
});

describe('test filters under --shard', () => {
  const TITLES = ['a', 'b', 'c', 'd', 'e', 'f'];
  /**
   * Six one-test files and one filter that logs the titles it was given to
   * `given.log`: with `FILTER_MODE=random` it leaves out a different half
   * every process, otherwise every test but a, c, d, and f.
   */
  function shardProject(): FixtureProject {
    const files: Record<string, string> = {
      'e2e.config.ts': cliConfig(`[
    { name: 'areas', filter(tests, { projectRoot }) {
      appendFileSync(path.join(projectRoot, 'given.log'), JSON.stringify(tests.map((test) => test.titlePath.at(-1))) + '\\n');
      const left = process.env.FILTER_MODE === 'random'
        ? tests.map((test) => ({ test, key: Math.random() })).sort((x, y) => x.key - y.key).slice(0, Math.floor(tests.length / 2)).map(({ test }) => test)
        : tests.filter((test) => test.titlePath.at(-1) === 'b' || test.titlePath.at(-1) === 'e');
      return { exclude: Object.fromEntries(left.map((test) => [test.id, 'unaffected'])) };
    } },
  ]`),
    };
    for (const title of TITLES) files[`tests/${title}.e2e.ts`] = testFile(title);
    return fixture(files);
  }

  /** Runs `args` and returns the titles the filter was given and the report it wrote. */
  function shardRun(project: FixtureProject, args: readonly string[], env: NodeJS.ProcessEnv = {}): { given: string[]; report: Report1Document } {
    const given = path.join(project.dir, 'given.log');
    rmSync(given, { force: true });
    const ran = cli(project, ['run', '--changed-since', 'main', ...args], env);
    expect(ran.exitCode, ran.output).toBe(0);
    const calls = readFileSync(given, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    return { given: calls[0]!, report: reportOf(project) };
  }

  it('hands each shard only its own slice, cut before the filter decides, and the shards run exactly the unsharded filtered set', () => {
    const project = shardProject();
    const whole = shardRun(project, []);
    expect(whole.given).toEqual(TITLES);
    expect(executedTests(whole.report)).toEqual(['a', 'c', 'd', 'f']);

    const [first, second] = ['1/2', '2/2'].map((shard) => shardRun(project, ['--shard', shard])) as [ReturnType<typeof shardRun>, ReturnType<typeof shardRun>];
    expect(first.given).toEqual(['a', 'b', 'c']);
    expect(second.given).toEqual(['d', 'e', 'f']);
    expect(executedTests(first.report)).toEqual(['a', 'c']);
    expect(executedTests(second.report)).toEqual(['d', 'f']);
    expect([...executedTests(first.report), ...executedTests(second.report)].toSorted()).toEqual(executedTests(whole.report));

    // Each shard records the filter over its slice; the other slice keeps its own reason.
    expect(first.report.run.filters).toEqual([expect.objectContaining({ name: 'areas', candidates: 3, excluded: 1 })]);
    expect(second.report.run.filters).toEqual([expect.objectContaining({ name: 'areas', candidates: 3, excluded: 1 })]);
    expect(row(first.report, 'b').skip).toEqual({ cause: 'filtered', filter: 'areas', reason: 'unaffected' });
    expect(row(first.report, 'e').skip).toEqual({ cause: 'filtered', reason: 'outside the shard' });
    expect(row(second.report, 'b').skip).toEqual({ cause: 'filtered', reason: 'outside the shard' });
  });

  it('never runs a test on two shards or drops one between them, whatever a non-deterministic filter answers', () => {
    const project = shardProject();
    for (let round = 0; round < 2; round += 1) {
      const [first, second] = ['1/2', '2/2'].map((shard) => shardRun(project, ['--shard', shard], { FILTER_MODE: 'random' })) as [
        ReturnType<typeof shardRun>,
        ReturnType<typeof shardRun>,
      ];
      expect(first.given).toEqual(['a', 'b', 'c']);
      expect(second.given).toEqual(['d', 'e', 'f']);
      const ranFirst = executedTests(first.report);
      const ranSecond = executedTests(second.report);
      expect(ranFirst).toHaveLength(2);
      expect(ranSecond).toHaveLength(2);
      expect(ranFirst.filter((title) => ranSecond.includes(title))).toEqual([]);
      // Every test is judged on exactly one shard: it ran there or that shard's filter left it out.
      for (const title of TITLES) {
        const owner = ['a', 'b', 'c'].includes(title) ? first.report : second.report;
        const other = owner === first.report ? second.report : first.report;
        expect(row(owner, title).selected || row(owner, title).skip?.filter === 'areas', title).toBe(true);
        expect(row(other, title).skip, title).toEqual({ cause: 'filtered', reason: 'outside the shard' });
      }
    }
  });
});

describe('what core settles after a filter', () => {
  const WIZARD = `import { test } from 'e2e';
test.describe('wizard', { serial: true }, () => {
  test('step one', async () => {});
  test('step two', async () => {});
  test('step three', async () => {});
});
test('lone', async () => {});
`;

  it('keeps a serial group whole when a filter names one member, and drops it when it names them all', async () => {
    const project = fixture({ 'tests/wizard.e2e.ts': WIZARD });
    /** A filter that leaves out the tests titled `titles`. */
    const leaveOut = (titles: readonly string[]): TestFilter => ({
      name: 'groups',
      filter: (tests) => ({ exclude: Object.fromEntries(tests.filter((test) => titles.includes(titleOf(test))).map((test) => [test.id, 'not reached'])) }),
    });

    const notices: string[] = [];
    const partial = await runExisting(project, {
      config: { filters: [leaveOut(['step two'])] },
      runOptions: { onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(partial.report.run.errors).toEqual([]);
    expect(partial.exitCode).toBe(0);
    let report = reportOf(project);
    expect(executedTests(report)).toEqual(['lone', 'step one', 'step three', 'step two']);
    expect(row(report, 'step two').skip).toBeUndefined();
    expect(report.run.filters).toEqual([expect.objectContaining({ name: 'groups', candidates: 4, excluded: 0 })]);
    expect(notices).toEqual([`judging 1 file changed since ${baseOf(project).slice(0, 7)}`, 'groups kept all 4 tests']);

    const whole = await runExisting(project, { config: { filters: [leaveOut(['step one', 'step two', 'step three'])] } });
    expect(whole.exitCode).toBe(0);
    report = reportOf(project);
    expect(executedTests(report)).toEqual(['lone']);
    for (const title of ['step one', 'step two', 'step three']) {
      expect(row(report, title).skip).toEqual({ cause: 'filtered', filter: 'groups', reason: 'not reached' });
    }
    expect(report.run.filters).toEqual([expect.objectContaining({ candidates: 4, excluded: 3 })]);
  });

  it('runs a session setup only when a test that consumes it is kept, and never hands the filter a setup', async () => {
    const project = fixture({
      'tests/auth.setup.e2e.ts': `import { test } from 'e2e';
test.setup('sign in', { sessions: ['member'] }, async ({ app, session }) => {
  await app.open();
  await session.save('member');
});
`,
      'tests/member.e2e.ts': testFile('member page', "{ session: 'member' }"),
      'tests/guest.e2e.ts': testFile('guest page'),
    });
    const judged: string[][] = [];
    /** A filter that records the titles it was given and leaves out the test titled `title`. */
    const leaveOut = (title: string): TestFilter => ({
      name: 'pages',
      filter: (tests) => {
        judged.push(tests.map(titleOf));
        return { exclude: Object.fromEntries(tests.filter((test) => titleOf(test) === title).map((test) => [test.id, 'not reached'])) };
      },
    });
    /** The setup's row once the run ended: whether it ran at all. */
    const setupRan = (report: Report1Document) =>
      report.run.results.some((result) => result.kind === 'setup' && result.selected && result.attempts.length > 0);

    const withoutConsumer = await runExisting(project, { config: { filters: [leaveOut('member page')] } });
    expect(withoutConsumer.report.run.errors).toEqual([]);
    expect(withoutConsumer.exitCode).toBe(0);
    let report = reportOf(project);
    expect(executedTests(report)).toEqual(['guest page']);
    expect(setupRan(report)).toBe(false);

    const withConsumer = await runExisting(project, { config: { filters: [leaveOut('guest page')] } });
    expect(withConsumer.report.run.errors).toEqual([]);
    expect(withConsumer.exitCode).toBe(0);
    report = reportOf(project);
    expect(executedTests(report)).toEqual(['member page']);
    expect(setupRan(report)).toBe(true);
    expect(row(report, 'sign in').status).toBe('passed');

    expect(judged.map((titles) => titles.toSorted())).toEqual([
      ['guest page', 'member page'],
      ['guest page', 'member page'],
    ]);
  });
});
