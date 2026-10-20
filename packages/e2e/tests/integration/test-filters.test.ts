/**
 * Test filters (`filters` in the config, on by default, `--no-filter` /
 * `noFilter` to skip them) through the runner, the public `e2e/runner` API,
 * and the built CLI on the fake engine: what a filter is given, what it
 * leaves out and why, a run it leaves empty booting nothing, a filter that
 * fails or outruns the deadline leaving nothing out, interrupts, `e2e list`
 * as the dry run, and each shard judging only its own slice. Filters run
 * only on a change: each project here is a git repository whose `feature`
 * branch changes `src/app.ts`, judged with `changedSince: 'main'`, and the
 * environment is scrubbed of CI, so no run detects a pull request it is not.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../src/collect/registry.ts';
import type { Report1Document } from '../../src/report/build.ts';
import type { ListedPair, ListOptions } from '../../src/run/runner.ts';
import type { RunEvent } from '../../src/run/events.ts';
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

/** `listExisting` outside CI on one fake target, judging the change since `main` unless `options` says otherwise. */
function listExisting(project: FixtureProject, options: Omit<Partial<ListOptions>, 'config'> & { config?: Partial<E2EConfig> } = {}) {
  return listProjectAs(project, {
    env: LOCAL_ENV,
    changedSince: 'main',
    ...options,
    config: { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }], ...options.config },
  });
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

/** `filter` deciding as before, with `calls` recording what each call was handed: the candidates and the context. */
function recording(filter: TestFilter) {
  const calls: { readonly tests: readonly TestFilterCandidate[]; readonly context: TestFilterContext }[] = [];
  const recorded: TestFilter = {
    name: filter.name,
    filter: (tests, context) => {
      calls.push({ tests, context });
      return filter.filter(tests, context);
    },
  };
  return { filter: recorded, calls };
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

/** A file-backed config on the fake engine for the CLI, `filters` the source of its `filters` list. */
function cliConfig(filters: string): string {
  return `import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  filters: ${filters},
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
    const { filter, calls } = recording({
      name: 'areas',
      filter: (tests, context) => {
        context.log(`judging ${tests.length} tests`);
        return keepOnly('areas', ['alpha']).filter(tests, context);
      },
    });
    const events: string[] = [];
    const outcome = await runExisting(project, {
      config: { filters: [filter] },
      runOptions: { onEvent: (event) => { events.push(describeEvent(event)); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');

    // The filter got the collected tests by id, file, title path, and tags,
    // never their bodies, plus the run's context.
    expect(calls).toHaveLength(1);
    const [{ tests, context }] = calls as [(typeof calls)[number]];
    expect(tests.map((test) => ({ ...test }))).toEqual(
      ['alpha', 'beta', 'gamma'].map((title) => ({ id: row(reportOf(project), title).testId, file: `tests/${title}.e2e.ts`, titlePath: [title], tags: [] })),
    );
    expect(context.projectRoot).toBe(project.dir);
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

  it('skips every filter with noFilter through the public e2e/runner run(), and applies them without it', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', ['alpha']));
    const config = { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], filters: [filter] } satisfies E2EConfig;

    const unfiltered = await publicRunner.run({ cwd: project.dir, config, noFilter: true, changedSince: 'main' });
    expect(unfiltered.exitCode).toBe(0);
    expect(executedTests(unfiltered.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(unfiltered.report.run.filters).toBeUndefined();
    expect(calls).toEqual([]);

    const filtered = await publicRunner.run({ cwd: project.dir, config, changedSince: 'main' });
    expect(filtered.exitCode).toBe(0);
    expect(executedTests(filtered.report)).toEqual(['alpha']);
    expect(filtered.report.run.filters).toEqual([expect.objectContaining({ name: 'areas', candidates: 3, excluded: 2 })]);
    assertValidReport(filtered.report);
    expect(calls).toHaveLength(1);
  });

  it('repeats only what the filters kept, after they decided, and records a left-out test once', async () => {
    const project = fixture(THREE_TESTS);
    const outcome = await runExisting(project, { config: { filters: [keepOnly('areas', ['alpha'])] }, runOptions: { repeatEach: 3 } });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    const report = reportOf(project);
    /** Each row of the test titled `title`: its repeat, whether it ran, and the filter that left it out. */
    const rows = (title: string) =>
      report.run.results.filter((result) => result.titlePath.at(-1) === title).map((result) => [result.repeat, result.selected, result.skip?.filter]);
    expect(rows('alpha')).toEqual([[0, true, undefined], [1, true, undefined], [2, true, undefined]]);
    expect(rows('beta')).toEqual([[0, false, 'areas']]);
    expect(rows('gamma')).toEqual([[0, false, 'areas']]);
  });

  it('never calls a filter on the tests run({ tests }) brings, as e2e explore runs them', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', []));
    const registration = await registry.collectModule(async () => registry.test('explore the app', async () => {}));
    const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { tests: { file: 'explore', registration } } });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(outcome.report.run.results.map((result) => [result.titlePath.at(-1), result.status])).toEqual([['explore the app', 'passed']]);
    expect(outcome.report.run.filters).toBeUndefined();
    expect(outcome.report.run.changes).toBeUndefined();
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
    expect(events).toContain('plan');
    expect(events.filter((event) => event.startsWith('setup:') && !/^setup:(collect|filter)/.test(event))).toEqual([]);
    // The run still began: the earlier evidence is gone and this report replaced it.
    expect(existsSync(stale)).toBe(false);
    const report = reportOf(project);
    expect(report.run.results.map((result) => result.selected)).toEqual([false, false, false]);
    expect(report.run.results.every((result) => result.skip?.filter === 'areas')).toBe(true);
  });

  it('passes an empty selection under passWithNoTests, with or without filters, calling none and preparing and starting nothing', async () => {
    const project = fixture({ ...THREE_TESTS, ...STARTUP_SCRIPTS });
    const prepared = path.join(project.dir, 'prepared');
    const startupLog = path.join(project.dir, 'startup.log');
    const unfiltered = await runExisting(project, {
      config: { targets: [await markedTarget(project.dir)] },
      runOptions: { tags: ['nope'], passWithNoTests: true },
    });
    expect(unfiltered.report.run.errors).toEqual([]);
    expect(unfiltered.exitCode).toBe(0);
    expect(reportOf(project).run.results.map((result) => result.selected)).toEqual([false, false, false]);
    expect(reportOf(project).run.filters).toBeUndefined();

    const { filter, calls } = recording(keepOnly('areas', []));
    const events: string[] = [];
    const filtered = await runExisting(project, {
      config: { targets: [await markedTarget(project.dir)], filters: [filter] },
      runOptions: { tags: ['nope'], passWithNoTests: true, onEvent: (event) => { events.push(describeEvent(event)); } },
    });
    expect(filtered.report.run.errors).toEqual([]);
    expect(filtered.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(events).toContain('notice:filter:no tests to judge, so no filter ran');
    expect(events.some((event) => event.startsWith('setup:filter'))).toBe(false);
    expect(reportOf(project).run.filters).toBeUndefined();
    expect(reportOf(project).run.changes).toEqual({ files: 0, skipped: 'no tests to judge' });
    expect(existsSync(prepared)).toBe(false);
    expect(existsSync(startupLog)).toBe(false);

    // The markers are real: the same target with work to do prepares its engine and starts its app.
    const ran = await runExisting(project, { config: { targets: [await markedTarget(project.dir)] } });
    expect(ran.report.run.errors).toEqual([]);
    expect(ran.exitCode).toBe(0);
    expect(existsSync(prepared)).toBe(true);
    expect(readFileSync(startupLog, 'utf8')).toBe('app\n');
  });
});

describe('when the filters run', () => {
  it('calls no filter outside a pull request, and judges a GitHub pull request from the base its event names', async () => {
    const project = fixture(THREE_TESTS);
    const base = baseOf(project);
    const { filter, calls } = recording(keepOnly('areas', ['alpha']));

    const local = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince: undefined } });
    expect(local.report.run.errors).toEqual([]);
    expect(calls).toEqual([]);
    expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
    expect(reportOf(project).run.changes).toEqual({ files: 0, skipped: 'not a pull request' });

    const eventPath = path.join(project.dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
    const pullRequest = { ...LOCAL_ENV, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_BASE_REF: 'main' };
    const judged = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince: undefined, env: pullRequest } });
    expect(judged.report.run.errors).toEqual([]);
    expect(calls.map(({ context }) => context.changes)).toEqual([expect.objectContaining({ base, files: ['src/app.ts'] })]);
    expect(executedTests(reportOf(project))).toEqual(['alpha']);
    expect(reportOf(project).run.changes).toEqual({ base, files: 1 });
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
    const { filter, calls } = recording(keepOnly('areas', []));
    const outcome = await runExisting(project, { config: { filters: [filter] } });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(calls.map(({ tests }) => tests.map(titleOf))).toEqual([['guest page']]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['member page']);
    expect(row(report, 'sign in')).toMatchObject({ selected: true, status: 'passed' });
    expect(row(report, 'guest page').skip).toEqual({ cause: 'filtered', filter: 'areas', reason: 'the diff misses guest page' });
    expect(report.run.changes).toEqual({ base: baseOf(project), files: 1, pinned: 1 });
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

  it('abandons a filter past the deadline and steps past one that throws, runs every test either was given, and passes, recording timedOut and failed', async () => {
    const project = fixture(THREE_TESTS);
    const notices: string[] = [];
    const finished: { readonly name: string; readonly outcome: string | undefined }[] = [];
    const slow: TestFilter = { name: 'slow', filter: () => new Promise(() => undefined) };
    const boom: TestFilter = { name: 'boom', filter: () => { throw new Error('kaboom'); } };
    const outcome = await runExisting(project, {
      config: { filters: [slow, boom, keepOnly('areas', ['alpha', 'beta'])] },
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
      { name: 'slow', candidates: 3, excluded: 0, note: 'did not finish within 50ms, so it leaves nothing out', timedOut: true },
      { name: 'boom', candidates: 3, excluded: 0, note: 'failed, so it leaves nothing out: kaboom', failed: true },
      { name: 'areas', candidates: 3, excluded: 1 },
    ]);
    expect(notices).toContain('warning: boom failed, so it leaves nothing out: kaboom');
    // A step that left nothing out never reads as done.
    expect(finished).toEqual([{ name: 'slow', outcome: 'timed out' }, { name: 'boom', outcome: 'failed' }, { name: 'areas', outcome: undefined }]);
  });

  it('fails an empty selection with NO_TESTS before asking git or calling a filter, on run and list', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', []));
    // A ref git cannot measure from proves git was never asked.
    const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { grep: [/nothing/], changedSince: 'nope' } });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'NO_TESTS', phase: 'collection' })]);
    expect(outcome.report.run.changes).toBeUndefined();
    await expect(listExisting(project, { config: { filters: [filter] }, grep: [/nothing/], changedSince: 'nope' })).rejects.toMatchObject({ code: 'NO_TESTS' });
    expect(calls).toEqual([]);
  });

  it('never asks git for the change when no filter would run: with noFilter or with no filters configured, on run and list', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', []));
    for (const [filters, noFilter] of [[[filter], true], [[], false]] as const) {
      const outcome = await runExisting(project, { config: { filters }, runOptions: { changedSince: 'nope', noFilter } });
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(0);
      expect(executedTests(reportOf(project))).toEqual(['alpha', 'beta', 'gamma']);
      const listed = await listExisting(project, { config: { filters }, changedSince: 'nope', noFilter });
      expect(listed.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    }
    expect(calls).toEqual([]);
  });

  it('ignores a collected test a filter names but was not given, such as one outside the shard, whose fate stands', async () => {
    /** A filter that leaves out the test titled `title`, found by renaming the first test it is given. */
    const naming = (name: string, from: string, title: string): TestFilter => ({
      name,
      filter: (tests) => ({ exclude: { [tests[0]!.id.replaceAll(from, title)]: 'unaffected' } }),
    });
    const project = fixture(THREE_TESTS);
    const shard = await runExisting(project, { config: { filters: [naming('areas', 'alpha', 'gamma')] }, runOptions: { shard: { index: 1, total: 2 } } });
    expect(shard.report.run.errors).toEqual([]);
    expect(shard.exitCode).toBe(0);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta']);
    expect(row(report, 'gamma').skip).toEqual({ cause: 'filtered', reason: 'outside the shard' });
    expect(report.run.filters).toEqual([{ name: 'areas', candidates: 2, excluded: 0 }]);
  });

  it('is INVALID_CHANGED_SINCE, exit 2, for a changedSince that is not a string or names a ref git cannot measure from, on run and list, calling no filter', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', []));
    const cases = [
      [true as unknown as string, 'config', 'changedSince must be a git ref, such as origin/main; got true'],
      ['origin/mian', 'filter', '--changed-since "origin/mian" names no commit in this checkout'],
    ] as const;
    for (const [changedSince, phase, message] of cases) {
      const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince } });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual([expect.objectContaining({ category: 'configuration', code: 'INVALID_CHANGED_SINCE', phase, message })]);
      await expect(listExisting(project, { config: { filters: [filter] }, changedSince })).rejects.toMatchObject({ code: 'INVALID_CHANGED_SINCE', message });
    }
    expect(calls).toEqual([]);
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
      await listExisting(project, { cwd: link, config: { filters: [areas] } });
      expect(joined).toEqual(['tests/alpha.e2e.ts', 'tests/beta.e2e.ts', 'tests/gamma.e2e.ts']);
    } finally {
      rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });
});

describe('interrupting a filter that ignores its signal', () => {
  it('exits the CLI with 130 at once on Ctrl-C, writing no report but all of its output, even to a reader that fell behind', async () => {
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
      await vi.waitFor(() => expect(existsSync(path.join(project.dir, 'filter-started'))).toBe(true), { timeout: 30_000, interval: 20 });
      child.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      reading = true;
      const readAt = Date.now();
      take();
      expect(await closed, stderr).toBe(130);
      expect(Date.now() - readAt).toBeLessThan(2_000);
      const stdout = Buffer.concat(chunks).toString();
      expect(stdout).toContain(`diff line 19999 ${'x'.repeat(40)}`);
      expect(stdout).toContain('interrupted while running filter "slow"');
      expect(stdout.trimEnd().split('\n').at(-1)).toMatch(/Report\s+\(not written\)/);
      expect(stdout + stderr).not.toContain('failed, running every test');
      expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('ends a run() interrupted, never read as a failed filter, recording no error and writing no report', async () => {
    const project = fixture(THREE_TESTS);
    const controller = new AbortController();
    const notices: string[] = [];
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
      runOptions: { interruptSignal: controller.signal, onEvent: (event) => { if (event.type === 'notice') notices.push(event.message); } },
    });
    expect(outcome.status).toBe('interrupted');
    expect(outcome.exitCode).toBe(130);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.results).toEqual([]);
    expect(seen?.aborted).toBe(true);
    expect(notices.filter((message) => message.startsWith('warning:'))).toEqual([]);
    assertValidReport(outcome.report);
    expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
  });
});

describe('e2e list with filters', () => {
  it('hands the filters only the slice --shard selects, keeping each other test\'s own reason', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/delta.e2e.ts': testFile('delta') });
    const { filter, calls } = recording(keepOnly('areas', ['alpha', 'gamma']));
    const sharded = await listExisting(project, { config: { filters: [filter] }, shard: { index: 1, total: 2 } });
    expect(calls.map(({ tests }) => tests.map(titleOf))).toEqual([['alpha', 'beta']]);
    expect(sharded.pairs.map((pair) => [pair.title, pair.disposition, pair.filter ?? pair.reason])).toEqual([
      ['alpha', 'run', undefined],
      ['beta', 'filtered', 'areas'],
      ['delta', 'filtered', 'outside the shard'],
      ['gamma', 'filtered', 'outside the shard'],
    ]);
  });

  it('prints the pairs a filter left out with the filter and its reason as json { pairs } with the summary on stderr, and every pair to run with a warning when the filter throws', () => {
    const project = fixture({
      ...THREE_TESTS,
      'e2e.config.ts': cliConfig(`[
    { name: 'areas', filter(tests, { log }) {
      log('asking about ' + tests.length + ' tests');
      if (process.env.FILTER_MODE === 'boom') throw new Error('kaboom');
      return { exclude: Object.fromEntries(tests.filter((test) => test.titlePath.at(-1) !== 'alpha').map((test) => [test.id, 'the diff misses ' + test.titlePath.at(-1)])), note: 'only alpha changed' };
    } },
  ]`),
    });
    const judging = `judging 1 file changed since ${baseOf(project).slice(0, 7)}`;
    const listed = cli(project, ['list', '--reporter', 'json', '--changed-since', 'main']);
    expect(listed.exitCode, listed.output).toBe(0);
    const json = JSON.parse(listed.stdout) as { pairs: ListedPair[] };
    expect(Object.keys(json)).toEqual(['pairs']);
    expect(json.pairs.map((pair) => [pair.title, pair.disposition, pair.filter, pair.reason])).toEqual([
      ['alpha', 'run', undefined, undefined],
      ['beta', 'filtered', 'areas', 'the diff misses beta'],
      ['gamma', 'filtered', 'areas', 'the diff misses gamma'],
    ]);
    expect(listed.stderr).toBe([judging, 'areas: asking about 3 tests', 'areas kept 1 of 3 tests, left out 2 (only alpha changed)', ''].join('\n'));

    const thrown = cli(project, ['list', '--reporter', 'json', '--changed-since', 'main'], { FILTER_MODE: 'boom' });
    expect(thrown.exitCode, thrown.output).toBe(0);
    expect((JSON.parse(thrown.stdout) as { pairs: ListedPair[] }).pairs.map((pair) => [pair.title, pair.disposition])).toEqual([['alpha', 'run'], ['beta', 'run'], ['gamma', 'run']]);
    expect(thrown.stderr).toBe([judging, 'areas: asking about 3 tests', 'warning: areas failed, so it leaves nothing out: kaboom', ''].join('\n'));
  });
});
