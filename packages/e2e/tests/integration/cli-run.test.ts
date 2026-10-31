/**
 * `e2e run` and `e2e list` through the built CLI on the fake engine, for what
 * only the process boundary decides: the exit code a crashed worker maps to,
 * shards that split one selection between two machines, the defaults a
 * worker resolves for itself when `CI` is set, and where a run error prints
 * when no reporter prints to the terminal.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** A config on the fake engine, `behavior` its `createFakeEngine` options, `extra` more config keys. */
function fakeConfig(behavior = '{}', extra = ''): string {
  return `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine(${behavior}).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',${extra}
} satisfies E2EConfig;
`;
}

/** A fixture project removed after the test. */
function fixture(files: Record<string, string>): FixtureProject {
  const created = createProject(files);
  projects.push(created);
  return created;
}

/** Writes a project and runs one CLI command in it; `CI` is unset unless `env` sets it. */
function cli(files: Record<string, string>, args: readonly string[], env: Record<string, string> = {}) {
  const created = fixture(files);
  return { project: created, ...rerun(created, args, env) };
}

/** Runs one more CLI command in an existing project. */
function rerun(existing: FixtureProject, args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: existing.dir,
    env: { ...process.env, CI: '', NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return { exitCode: result.status, output: result.stdout + result.stderr, stdout: result.stdout, stderr: result.stderr };
}

/** The report the last run wrote. */
function reportOf(ran: FixtureProject): Report1Document {
  const report = JSON.parse(readFileSync(path.join(ran.dir, '.e2e', 'report.json'), 'utf8')) as Report1Document;
  assertValidReport(report);
  return report;
}

/** Keeps a process alive the way a database pool opened at import does. */
const openTimer = 'setInterval(() => {}, 60_000);\n';

const test = (title: string, body = '') => `import { test } from 'e2e';\ntest('${title}', async ({ app }) => {\n  await app.open();\n  ${body}\n});\n`;

describe('the run command through the CLI', () => {
  it('exits 3 when a worker dies under a test', () => {
    const { project, exitCode } = cli(
      { 'e2e.config.ts': fakeConfig(), 'tests/crash.e2e.ts': test('crashes the worker', 'process.exit(7);') },
      ['run'],
    );
    expect(exitCode).toBe(3);
    const report = reportOf(project);
    expect(report.run.exitCode).toBe(3);
    expect(report.run.results.map((result) => result.attempts[0]?.error?.code)).toEqual(['WORKER_CRASH']);
  });

  it('splits one selection into shards that cover every test once, each with the setup its tests need', () => {
    const files: Record<string, string> = {
      'e2e.config.ts': fakeConfig('{ state: true }'),
      'tests/auth.setup.e2e.ts': `import { test } from 'e2e';\ntest.setup('sign in', { sessions: ['member'] }, async ({ app, session }) => {\n  await app.open();\n  await session.save('member');\n});\n`,
    };
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      files[`tests/${name}.e2e.ts`] = `import { test } from 'e2e';\ntest('${name}', { session: 'member' }, async ({ app }) => {\n  await app.open();\n});\n`;
    }
    const sharded = fixture(files);
    const listed = (shard: string) => {
      const { exitCode, stdout } = rerun(sharded, ['list', '--reporter', 'json', '--shard', shard]);
      expect(exitCode).toBe(0);
      const { pairs } = JSON.parse(stdout) as { pairs: { title: string; kind: string }[] };
      return pairs;
    };
    const [first, second] = [listed('1/2'), listed('2/2')];
    const tests = (pairs: { title: string; kind: string }[]) => pairs.filter((pair) => pair.kind === 'test').map((pair) => pair.title);
    expect([...tests(first), ...tests(second)].toSorted()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(tests(first).filter((title) => tests(second).includes(title))).toEqual([]);
    expect(tests(first).length).toBeGreaterThan(0);
    expect(tests(second).length).toBeGreaterThan(0);
    for (const pairs of [first, second]) {
      expect(pairs.filter((pair) => pair.kind === 'setup').map((pair) => pair.title)).toEqual(['sign in']);
    }

    const ran = rerun(sharded, ['run', '--shard', '2/2']);
    expect(ran.exitCode).toBe(0);
    const executed = reportOf(sharded).run.results.filter((result) => result.attempts.length > 0);
    expect(executed.map((result) => result.titlePath.at(-1)).toSorted()).toEqual(['sign in', ...tests(second)].toSorted());
  });

  it('fails a wrong locator and a wrong expectation at the timeout flags, not the config\'s, and a call\'s own timeout still wins', () => {
    const { project, exitCode } = cli(
      {
        'e2e.config.ts': fakeConfig('{ locate: () => [] }', '\n  actionTimeout: 30_000,\n  assertionTimeout: 30_000,'),
        'tests/timeouts.e2e.ts': `import { expect, test } from 'e2e';
test('taps a button that is not there', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Submit now' }).tap();
});
test('expects a heading that is not there', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});
test('taps with its own timeout', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Submit now' }).tap({ timeout: 1_500 });
});
`,
      },
      ['run', '--action-timeout', '400', '--assertion-timeout', '300'],
    );
    expect(exitCode).toBe(1);
    const results = reportOf(project).run.results;
    /** The failed step of the test titled `title`, with the error its attempt ended on. */
    const failed = (title: string) => {
      const attempt = results.find((result) => result.titlePath.at(-1) === title)?.attempts.at(-1);
      const step = attempt?.steps.find((candidate) => candidate.status !== 'passed');
      if (attempt === undefined || step === undefined) throw new Error(`no failed step in ${title}`);
      return { error: attempt.error, step };
    };
    // The worker is a child process that resolves the config again: the flags reach it, or these wait 30 s.
    const tap = failed('taps a button that is not there');
    expect(tap.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(tap.error?.details?.waitedMs).toBeGreaterThanOrEqual(400);
    expect(tap.step.durationMs).toBeLessThan(5_000);
    const assertion = failed('expects a heading that is not there');
    expect(assertion.error?.code).toBe('ASSERTION_FAILED');
    expect(assertion.step.durationMs).toBeGreaterThanOrEqual(300);
    expect(assertion.step.durationMs).toBeLessThan(5_000);
    const own = failed('taps with its own timeout');
    expect(own.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(own.error?.details?.waitedMs).toBeGreaterThanOrEqual(1_500);
    expect(own.step.durationMs).toBeLessThan(5_000);
  });

  it('under CI, refuses a focused test and retries a failure once', () => {
    const focused = cli(
      { 'e2e.config.ts': fakeConfig(), 'tests/only.e2e.ts': `import { test } from 'e2e';\ntest.only('focused', async () => {});\ntest('other', async () => {});\n` },
      ['run'],
      { CI: 'true' },
    );
    expect(focused.exitCode).toBe(2);
    expect(focused.output).toContain('ONLY_IN_CI');

    const flaky = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/flaky.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('fails once', async ({ app }) => {
  await app.open();
  const marker = new URL('./failed-once', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new Error('first attempt fails');
  }
});
`,
      },
      ['run'],
      { CI: 'true' },
    );
    expect(flaky.exitCode).toBe(0);
    const [result] = reportOf(flaky.project).run.results;
    expect(result?.status).toBe('flaky');
    expect(result?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
  });

  it('ends run and list with their exit codes when the config and a test file leave a timer open', () => {
    const project = fixture({
      'e2e.config.ts': fakeConfig() + openTimer,
      'tests/pass.e2e.ts': test('passes') + openTimer,
      'tests/fail.e2e.ts': test('fails', "throw new Error('expected failure');") + openTimer,
    });
    expect(rerun(project, ['run', 'tests/pass.e2e.ts']).exitCode).toBe(0);
    expect(reportOf(project).run.exitCode).toBe(0);
    expect(rerun(project, ['run', 'tests/fail.e2e.ts']).exitCode).toBe(1);
    const listed = rerun(project, ['list']);
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain('passes');
  });

  it('exits 3 when a passed test failed its cleanup and the config leaves a timer open', () => {
    const { exitCode } = cli(
      {
        'e2e.config.ts': fakeConfig("{ onEndAttempt() { throw new Error('cleanup failed'); } }") + openTimer,
        'tests/pass.e2e.ts': test('passes'),
      },
      ['run'],
    );
    expect(exitCode).toBe(3);
  });

  it('exits 0 with the whole json report on stdout when a test file leaves a timer open', () => {
    const titles = Array.from({ length: 400 }, (_, index) => `test number ${index}`);
    const { exitCode, stdout } = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/many.e2e.ts': `import { test } from 'e2e';\n${openTimer}for (const title of ${JSON.stringify(titles)}) test(title, async () => {});\n`,
      },
      ['run', '--reporter', 'json'],
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.results).toHaveLength(titles.length);
  });

  it('prints a run error on stderr once, whichever reporters run, and keeps the json document whole', () => {
    const project = fixture({
      'e2e.config.ts': fakeConfig(),
      'tests/broken.e2e.ts': "import { test } from 'e2e';\ntest('broken', async () => { const text = 'unterminated; });\n",
    });
    const reason = /COLLECTION_ERROR[\s\S]*failed to collect tests\/broken\.e2e\.ts: .*Unterminated string/u;
    const timesNamed = (text: string) => text.split('failed to collect tests/broken.e2e.ts').length - 1;
    for (const reporter of ['junit', 'markdown']) {
      const ran = rerun(project, ['run', '--reporter', reporter]);
      expect(ran.exitCode, reporter).toBe(2);
      expect(ran.stderr, reporter).toMatch(reason);
      expect(timesNamed(ran.output), reporter).toBe(1);
    }
    const json = rerun(project, ['run', '--reporter', 'json']);
    expect(json.exitCode).toBe(2);
    const report = JSON.parse(json.stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.errors.map((error) => error.code)).toEqual(['COLLECTION_ERROR']);
    expect(json.stderr).toMatch(reason);
    const list = rerun(project, ['run', '--reporter', 'list,junit']);
    expect(list.exitCode).toBe(2);
    expect(list.stdout).toMatch(reason);
    expect(timesNamed(list.output)).toBe(1);
  });
});
