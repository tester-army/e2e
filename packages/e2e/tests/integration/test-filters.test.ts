/**
 * Test filters (`filters` in the config, run with `--changed-since` /
 * `changedSince`) through the runner, the public `e2e/runner` API, and the
 * built CLI on the fake engine: what a filter is given, what it leaves out
 * and why, a run it leaves empty booting nothing, a filter that fails or
 * outruns the deadline leaving nothing out, interrupts, `e2e list` as the
 * dry run, and each shard judging only its own slice. Each project here is
 * a git repository whose `feature` branch changes `src/app.ts`, judged with
 * `changedSince: 'main'`, outside CI.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { renderMarkdownReport } from '../../src/report/markdown.ts';
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

/** The environment of every run here: outside CI. */
const LOCAL_ENV: NodeJS.ProcessEnv = { ...process.env, CI: '', GITHUB_ACTIONS: '' };

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

  it('calls no filter without changedSince through the public e2e/runner run(), and applies them with it', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', ['alpha']));
    const config = { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], filters: [filter] } satisfies E2EConfig;

    const unfiltered = await publicRunner.run({ cwd: project.dir, config });
    expect(unfiltered.exitCode).toBe(0);
    expect(executedTests(unfiltered.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(unfiltered.report.run.filters).toBeUndefined();
    expect(unfiltered.report.run.changes).toBeUndefined();
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

  it('records what the filters left out when the run stops before its tests, so the events and the page count it', async () => {
    const project = fixture(THREE_TESTS);
    const fake = createFakeEngine().engine;
    const target: Target = {
      name: 'fake',
      platform: 'fake',
      engine: {
        ...fake,
        prepare() {
          throw new Error('no simulator');
        },
      },
      app: FAKE_APP,
    };
    const finished: string[] = [];
    const outcome = await runExisting(project, {
      config: { targets: [target], filters: [keepOnly('areas', ['alpha'])] },
      runOptions: { onEvent: (event) => { if (event.type === 'test-finished') finished.push(event.result.test.titlePath.at(-1)!); } },
    });
    expect(outcome.report.run.errors).toEqual([expect.objectContaining({ phase: 'launch' })]);
    expect(outcome.report.run.results.map((result) => [result.titlePath.at(-1), result.selected, result.skip?.filter])).toEqual([
      ['beta', false, 'areas'],
      ['gamma', false, 'areas'],
    ]);
    expect(finished).toEqual(['beta', 'gamma']);
    expect(outcome.results.map((result) => result.test.titlePath.at(-1))).toEqual(['beta', 'gamma']);
    assertValidReport(outcome.report);
    const page = renderMarkdownReport(outcome.report);
    expect(page).toContain(', 2 left out by filters\n');
    expect(page).toContain('**Filter** `areas` kept 1 of 3 tests, left out 2\n');
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
    expect(reportOf(project).run.changes).toEqual({ skipped: 'no tests to judge' });
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
  it('calls no filter when no file changed since the merge base, recording the base and why', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', []));
    const head = runGit(project.dir, 'rev-parse', 'HEAD');
    const listed = await listExisting(project, { config: { filters: [filter] }, changedSince: 'HEAD' });
    expect(listed.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince: 'HEAD' } });
    expect(outcome.exitCode).toBe(0);
    expect(reportOf(project).run.changes).toEqual({ base: head, files: 0, skipped: `no files changed since ${head.slice(0, 7)}` });
    expect(calls).toEqual([]);
  });

  it('calls no filter, asks no git, and says nothing without changedSince, on run and list, recording no change and no filter', async () => {
    const project = createProject(THREE_TESTS);
    projects.push(project);
    // A .git file naming no repository fails every git call here, where git would otherwise find the package's own checkout.
    writeFileSync(path.join(project.dir, '.git'), 'gitdir: nowhere\n');
    const { filter, calls } = recording(keepOnly('areas', []));
    const notices: string[] = [];
    const outcome = await runExisting(project, {
      config: { filters: [filter] },
      runOptions: { changedSince: undefined, onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.changes).toBeUndefined();
    expect(report.run.filters).toBeUndefined();
    const listed = await listExisting(project, { config: { filters: [filter] }, changedSince: undefined });
    expect(listed.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    expect(calls).toEqual([]);
    expect(notices).toEqual([]);
    // With changedSince, git is asked, and fails.
    await expect(listExisting(project, { config: { filters: [filter] } })).rejects.toMatchObject({ code: 'INVALID_CHANGED_SINCE' });
  });

  it('hands the filters every test, even one whose setup file changed, and their answer stands', async () => {
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
    expect(calls.map(({ tests }) => tests.map(titleOf).toSorted())).toEqual([['guest page', 'member page']]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual([]);
    expect(row(report, 'member page').skip).toEqual({ cause: 'filtered', filter: 'areas', reason: 'the diff misses member page' });
    expect(report.run.changes).toEqual({ base: baseOf(project), files: 1 });
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
    expect(report.run.changes).toEqual({ skipped: '--last-failed' });
    expect(report.run.filters).toBeUndefined();
    expect(notices).toEqual(['--last-failed: the tests the last run owes run without filters']);
  });

  it('abandons a filter past the deadline and steps past one that throws, runs every test either was given, and passes, recording outcome timed-out and failed', async () => {
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
      { name: 'slow', candidates: 3, excluded: 0, note: 'did not finish within 50ms, so it leaves nothing out', outcome: 'timed-out' },
      { name: 'boom', candidates: 3, excluded: 0, note: 'failed, so it leaves nothing out: kaboom', outcome: 'failed' },
      { name: 'areas', candidates: 3, excluded: 1 },
    ]);
    expect(notices).toContain('warning: boom failed, so it leaves nothing out: kaboom');
    // A step that left nothing out never reads as done.
    expect(finished).toEqual([{ name: 'slow', outcome: 'timed-out' }, { name: 'boom', outcome: 'failed' }, { name: 'areas', outcome: undefined }]);
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

  it('warns that the config has no filters when changedSince has none to run, asking no git, on run and list', async () => {
    const project = fixture({ ...THREE_TESTS, 'e2e.config.ts': cliConfig('[]') });
    const warning = 'warning: --changed-since: the config has no filters, so every test runs';
    const notices: string[] = [];
    // A ref git cannot measure from proves git was never asked.
    const outcome = await runExisting(project, {
      config: { filters: [] },
      runOptions: { changedSince: 'nope', onEvent: (event) => { if (event.type === 'notice' && event.target === 'filter') notices.push(event.message); } },
    });
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(notices).toEqual([warning]);
    const report = reportOf(project);
    expect(executedTests(report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.run.changes).toBeUndefined();
    expect(report.run.filters).toBeUndefined();

    const listed = cli(project, ['list', '--reporter', 'json', '--changed-since', 'nope']);
    expect(listed.exitCode, listed.output).toBe(0);
    expect((JSON.parse(listed.stdout) as { pairs: ListedPair[] }).pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    expect(listed.stderr).toBe(`${warning}\n`);
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
      [true as unknown as string, 'config', '--changed-since must name a git ref, such as origin/main; got true'],
      ['', 'config', '--changed-since must name a git ref, such as origin/main; got ""'],
      ['--output=x', 'config', '--changed-since must name a git ref, such as origin/main; got "--output=x"'],
      ['origin/mian', 'filter', '--changed-since "origin/mian" names no commit in this checkout; fetch it, such as with fetch-depth: 0 on actions/checkout or GIT_DEPTH: 0 on GitLab'],
    ] as const;
    for (const [changedSince, phase, message] of cases) {
      const outcome = await runExisting(project, { config: { filters: [filter] }, runOptions: { changedSince } });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual([expect.objectContaining({ category: 'configuration', code: 'INVALID_CHANGED_SINCE', phase, message })]);
      await expect(listExisting(project, { config: { filters: [filter] }, changedSince })).rejects.toMatchObject({ code: 'INVALID_CHANGED_SINCE', message });
    }
    expect(calls).toEqual([]);
  });

  it('is INVALID_CHANGED_SINCE for an empty ref or one that reads as an option even when no filter would run: no filters, --last-failed, or no tests', async () => {
    const project = fixture(THREE_TESTS);
    const { filter, calls } = recording(keepOnly('areas', []));
    const message = '--changed-since must name a git ref, such as origin/main; got "-x"';
    const cases: readonly ({ config: Partial<E2EConfig> } & Pick<ListOptions, 'lastFailed' | 'grep'>)[] = [
      { config: { filters: [] } },
      { config: { filters: [filter] }, lastFailed: true },
      { config: { filters: [filter] }, grep: [/nothing/] },
    ];
    for (const { config, ...options } of cases) {
      const outcome = await runExisting(project, { config, runOptions: { ...options, changedSince: '-x' } });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'INVALID_CHANGED_SINCE', phase: 'config', message })]);
      await expect(listExisting(project, { config, ...options, changedSince: '-x' })).rejects.toMatchObject({ code: 'INVALID_CHANGED_SINCE', message });
    }
    expect(calls).toEqual([]);
  });
});

describe('what a filter is told', () => {
  it('hands a project reached through a symlink its resolved root, so its test files join the change root', async () => {
    const project = fixture(THREE_TESTS, { 'tests/beta.e2e.ts': testFile('beta', '{ tags: [] }') });
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-filter-link-')), 'project');
    symlinkSync(project.dir, link);
    try {
      let joined: string[] = [];
      let changed: readonly string[] = [];
      const areas: TestFilter = {
        name: 'areas',
        filter: (tests, { projectRoot, changes }) => {
          joined = tests.map((test) => path.relative(changes.root, path.join(projectRoot, test.file)).split(path.sep).join('/'));
          changed = changes.files;
          return { exclude: {} };
        },
      };
      await listExisting(project, { cwd: link, config: { filters: [areas] } });
      expect(joined).toEqual(['tests/alpha.e2e.ts', 'tests/beta.e2e.ts', 'tests/gamma.e2e.ts']);
      expect(changed).toEqual(['tests/beta.e2e.ts']);
    } finally {
      rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  it('names the config file the run loaded, whatever its name, relative to the repository root, and none for a config object', async () => {
    const config = cliConfig("[{ name: 'areas', filter(tests, { configFile, log }) { log('config ' + configFile); return { exclude: {} }; } }]");
    const nested = config.replace("'../../helpers/", "'../../../../helpers/");
    const project = fixture({ ...THREE_TESTS, 'e2e.config.ts': config, 'e2e.ci.config.ts': config, 'apps/web/e2e.ci.config.ts': nested, 'apps/web/tests/alpha.e2e.ts': testFile('alpha') });
    const told = (cwd: string, args: readonly string[]) => {
      const listed = cli({ dir: cwd, cleanup: () => undefined }, ['list', '--changed-since', 'main', ...args]);
      expect(listed.exitCode, listed.output).toBe(0);
      return listed.output.split('\n').filter((line) => line.startsWith('areas: config'));
    };
    expect(told(project.dir, [])).toEqual(['areas: config e2e.config.ts']);
    expect(told(project.dir, ['--config', 'e2e.ci.config.ts'])).toEqual(['areas: config e2e.ci.config.ts']);
    expect(told(path.join(project.dir, 'apps', 'web'), ['--config', 'e2e.ci.config.ts'])).toEqual(['areas: config apps/web/e2e.ci.config.ts']);
    // Git lists a symlinked config under the link's own path.
    symlinkSync('e2e.ci.config.ts', path.join(project.dir, 'e2e.link.config.ts'));
    expect(told(project.dir, ['--config', 'e2e.link.config.ts'])).toEqual(['areas: config e2e.link.config.ts']);

    const { filter, calls } = recording(keepOnly('areas', ['alpha', 'beta', 'gamma']));
    await listExisting(project, { config: { filters: [filter] } });
    expect(calls.map(({ context }) => context.configFile)).toEqual([undefined]);
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
      expect(stdout + stderr).not.toContain('warning: slow');
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

  it('redacts what the config and a filter print on e2e list, and keeps --reporter json stdout to the document', () => {
    const SECRET = 'sk-live-abcdef0123456789';
    const config = cliConfig(`[
    { name: 'leaky', filter(tests) {
      console.log('filter sees ' + process.env.LEAKY_SECRET);
      console.error('and says ' + process.env.LEAKY_SECRET);
      return { exclude: {} };
    } },
  ]`).replace('  filters:', `  secrets: { API_KEY: process.env.LEAKY_SECRET! },\n  filters:`).replace('export default {', "console.log('config sees ' + process.env.LEAKY_SECRET);\nexport default {");
    const project = fixture({ ...THREE_TESTS, 'e2e.config.ts': config });
    const json = cli(project, ['list', '--reporter', 'json', '--changed-since', 'main'], { LEAKY_SECRET: SECRET });
    expect(json.exitCode, json.output).toBe(0);
    expect((JSON.parse(json.stdout) as { pairs: ListedPair[] }).pairs).toHaveLength(3);
    expect(json.output).not.toContain(SECRET);
    expect(json.stderr).toContain('config sees <secret:API_KEY>');
    expect(json.stderr).toContain('filter sees <secret:API_KEY>');
    const text = cli(project, ['list', '--changed-since', 'main'], { LEAKY_SECRET: SECRET });
    expect(text.exitCode, text.output).toBe(0);
    expect(text.output).not.toContain(SECRET);
    expect(text.stdout).toContain('filter sees <secret:API_KEY>');
  });

  it('prints the pairs a filter left out with the filter and its reason as json { pairs } with the summary on stderr, every pair to run without --changed-since, and every pair to run with a warning when the filter throws', () => {
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
    // Without --changed-since no filter runs, and nothing is said.
    const unfiltered = cli(project, ['list', '--reporter', 'json']);
    expect(unfiltered.exitCode, unfiltered.output).toBe(0);
    expect((JSON.parse(unfiltered.stdout) as { pairs: ListedPair[] }).pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    expect(unfiltered.stderr).toBe('');

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
