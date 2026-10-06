/**
 * `output` and `--output`: every result a run writes lands under one
 * directory, the artifact tree is cleared once a run's tests start (a run
 * that stops before leaves the last run's evidence, and a `--last-failed`
 * rerun keeps what the report it reruns names), `--last-failed` reads the
 * report there, and a store's `putLink` receives the recordings a hosted
 * service keeps.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, resultByTitle, runExisting, runProject, type RunOutcome } from '../helpers/run-project.ts';
import type { StoredArtifact, StoredArtifactLink } from '../../src/index.ts';

const PASSING_TEST = `import { test } from 'e2e';

test('taps a node', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).tap();
});
`;

const FAILING_TEST = `import { test } from 'e2e';

test('fails on purpose', async ({ app }) => {
  await app.open('/');
  throw new Error('nope');
});
`;

const HOSTED = 'https://recordings.example/r.mp4';

/** A store that records what it is handed; `putLink` throws when `failLinks` is set. */
function capturingStore(options: { failLinks?: boolean } = {}) {
  const puts: StoredArtifact[] = [];
  const links: StoredArtifactLink[] = [];
  return {
    puts,
    links,
    store: {
      async put(artifact: StoredArtifact) {
        puts.push(artifact);
        return { ref: `store://${artifact.kind}/${artifact.sha256.slice(0, 8)}` };
      },
      async putLink(link: StoredArtifactLink) {
        links.push(link);
        if (options.failLinks === true) throw new Error('the bucket is down');
        return { ref: `store://link/${links.length}` };
      },
    },
  };
}

describe('output', () => {
  it(
    'writes the report, the reporter files, and the artifacts under output, and leaves .e2e alone',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/fail.e2e.ts': FAILING_TEST },
        { appUrl: FAKE_APP_URL, config: engineConfig(fake.engine, { output: 'out', reporters: ['list', 'junit', 'markdown'] }) },
      );
      try {
        assertValidReport(outcome.report);
        const output = path.join(project.dir, 'out');
        expect(outcome.reportPath).toBe(path.join(output, 'report.json'));
        for (const file of ['report.json', 'junit.xml', 'summary.md']) expect(existsSync(path.join(output, file)), file).toBe(true);
        const screenshot = resultByTitle(outcome, 'fails on purpose').attempts[0]!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
        expect(existsSync(path.join(output, 'results', screenshot.path!))).toBe(true);
        expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(false);
        expect(existsSync(path.join(project.dir, '.e2e', 'results'))).toBe(false);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'clears the artifact tree when a run starts, and reads --last-failed from the output the run names',
    async () => {
      const project = createProject({ 'tests/pass.e2e.ts': PASSING_TEST, 'tests/fail.e2e.ts': FAILING_TEST });
      try {
        const config = engineConfig(createFakeEngine({ artifacts: true }).engine, { output: 'out' });
        const first = await runExisting(project, { appUrl: FAKE_APP_URL, config });
        expect(first.status).toBe('failed');
        const stale = path.join(project.dir, 'out', 'results', 'stale', 'left-over.txt');
        mkdirSync(path.dirname(stale), { recursive: true });
        writeFileSync(stale, 'from a run long ago');

        const rerun = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { lastFailed: true } });
        expect(rerun.results.filter((result) => result.selected).map((result) => result.test.title)).toEqual(['fails on purpose']);
        expect(existsSync(stale)).toBe(false);

        // --output over the config: no report there yet, so nothing to rerun from.
        const elsewhere = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { lastFailed: true, output: 'other' } });
        expect(elsewhere.report.run.errors.map((error) => error.code)).toEqual(['NO_LAST_RUN']);
        expect(rerun.reportPath).toBe(path.join(project.dir, 'out', 'report.json'));
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'keeps the evidence a --last-failed rerun folds in, byte for byte, and files the rerun\'s own beside it',
    async () => {
      const project = createProject({ 'tests/pass.e2e.ts': PASSING_TEST, 'tests/fail.e2e.ts': FAILING_TEST });
      try {
        const config = engineConfig(createFakeEngine({ artifacts: true }).engine);
        const artifacts = path.join(project.dir, '.e2e', 'results');
        const screenshotOf = (outcome: RunOutcome) =>
          resultByTitle(outcome, 'fails on purpose').attempts[0]!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
        const onDisk = (artifact: { path?: string | undefined; sha256?: string | undefined }) =>
          createHash('sha256').update(readFileSync(path.join(artifacts, artifact.path!))).digest('hex') === artifact.sha256;

        const first = await runExisting(project, { appUrl: FAKE_APP_URL, config });
        const firstShot = screenshotOf(first);
        expect(firstShot.path).toMatch(/^fail-fails-on-purpose-[0-9a-f]{16}\/attempt-1\//);
        const planted = path.join(artifacts, 'planted.txt');
        writeFileSync(planted, 'named by no report');

        const rerun = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { lastFailed: true } });
        expect(rerun.status).toBe('failed');
        const rerunShot = screenshotOf(rerun);
        const inRerun = (n: number) => firstShot.path!.replace('/attempt-1/', `/rerun-${n}/attempt-1/`);
        expect(rerunShot.path).toBe(inRerun(1));
        expect(onDisk(firstShot)).toBe(true);
        expect(onDisk(rerunShot)).toBe(true);
        expect(existsSync(planted)).toBe(false);
        assertValidReport(rerun.report);

        // The next rerun keeps what the report it reruns names, the first run's evidence no more.
        const again = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { lastFailed: true } });
        expect(screenshotOf(again).path).toBe(inRerun(2));
        expect(onDisk(rerunShot)).toBe(true);
        expect(existsSync(path.join(artifacts, firstShot.path!))).toBe(false);

        // A full run starts from an empty tree, with no rerun directory left.
        const full = await runExisting(project, { appUrl: FAKE_APP_URL, config });
        expect(screenshotOf(full).path).toBe(firstShot.path);
        expect(readdirSync(path.join(artifacts, firstShot.path!.split('/')[0]!)).filter((entry) => entry.startsWith('rerun-'))).toEqual([]);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    "keeps the last run's report and artifacts when a run stops before its tests start",
    async () => {
      const project = createProject({
        'tests/pass.e2e.ts': PASSING_TEST,
        'tests/fail.e2e.ts': FAILING_TEST,
        'tests/broken.e2e.ts': `import { test } from 'e2e';\nthrow new Error('broken at import');\n`,
      });
      try {
        const fake = createFakeEngine({ artifacts: true });
        const config = engineConfig(fake.engine);
        const files = ['tests/pass.e2e.ts', 'tests/fail.e2e.ts'];
        const first = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { files } });
        expect(first.status).toBe('failed');
        const reportFile = path.join(project.dir, '.e2e', 'report.json');
        const report = readFileSync(reportFile, 'utf8');
        const screenshot = resultByTitle(first, 'fails on purpose').attempts[0]!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
        const evidence = path.join(project.dir, '.e2e', 'results', screenshot.path!);
        expect(existsSync(evidence)).toBe(true);
        const planted = path.join(project.dir, '.e2e', 'results', 'planted.txt');
        writeFileSync(planted, 'left by the last run');

        const stopped = [
          { files, grep: [/no such title/] },
          { files: ['tests/broken.e2e.ts'] },
          { files, lastFailed: true, grep: [/typo/] },
        ];
        for (const runOptions of stopped) {
          const outcome = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions });
          expect(outcome.exitCode, JSON.stringify(runOptions)).toBe(2);
          expect(outcome.reportPath).toBeUndefined();
          expect(existsSync(evidence)).toBe(true);
          expect(existsSync(planted)).toBe(true);
          expect(readFileSync(reportFile, 'utf8')).toBe(report);
        }
        const unrecordable = await runExisting(project, {
          appUrl: FAKE_APP_URL,
          config: { targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP, video: 'on' }] },
          runOptions: { files },
        });
        expect(unrecordable.report.run.errors.map((error) => error.code)).toEqual(['UNSUPPORTED_ARTIFACT']);
        expect(existsSync(evidence)).toBe(true);
        expect(readFileSync(reportFile, 'utf8')).toBe(report);

        const withCommand = (args: readonly string[]) =>
          ({
            targets: [
              {
                name: 'fake',
                platform: 'fake',
                engine: createFakeEngine({ artifacts: true }).engine,
                app: { url: FAKE_APP_URL, readyUrl: 'http://127.0.0.1:1/', command: { executable: process.execPath, args, startupTimeout: 60_000 } },
              },
            ],
          });
        const crashed = await runExisting(project, { appUrl: FAKE_APP_URL, config: withCommand(['-e', 'process.exit(3)']), runOptions: { files } });
        expect(crashed.report.run.errors).toHaveLength(1);
        expect(crashed.exitCode).not.toBe(0);
        expect(crashed.reportPath).toBeUndefined();
        expect(existsSync(planted)).toBe(true);
        expect(readFileSync(reportFile, 'utf8')).toBe(report);

        const interrupt = new AbortController();
        const cancelled = await runExisting(project, {
          appUrl: FAKE_APP_URL,
          config: withCommand(['-e', 'setInterval(() => {}, 1000)']),
          runOptions: {
            files,
            interruptSignal: interrupt.signal,
            onEvent: (event) => {
              if (event.type === 'setup' && event.step.kind === 'app' && event.state === 'started') interrupt.abort();
            },
          },
        });
        expect(cancelled.exitCode).toBe(130);
        expect(cancelled.reportPath).toBeUndefined();
        expect(existsSync(planted)).toBe(true);
        expect(readFileSync(reportFile, 'utf8')).toBe(report);

        const rerun = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { files, lastFailed: true } });
        expect(rerun.results.filter((result) => result.selected).map((result) => result.test.title)).toEqual(['fails on purpose']);
        expect(existsSync(planted)).toBe(false);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'refuses an output the run cannot own before anything runs',
    async () => {
      const fake = createFakeEngine();
      const { outcome, project } = await runProject(
        { 'tests/pass.e2e.ts': PASSING_TEST },
        { appUrl: FAKE_APP_URL, config: engineConfig(fake.engine, { output: '.' }) },
      );
      try {
        expect(outcome.exitCode).toBe(2);
        expect(fake.stats().attemptsStarted).toBe(0);
        expect(outcome.report.run.errors[0]).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('output "." is the project root') });
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});

describe('ArtifactStore.putLink', () => {
  it(
    'hands a hosted recording to putLink with its identity, and records the ref beside the url',
    async () => {
      const fake = createFakeEngine({ video: true, videoLinks: [HOSTED] });
      const { links, puts, store } = capturingStore();
      const { outcome, project } = await runProject(
        { 'tests/pass.e2e.ts': PASSING_TEST },
        { appUrl: FAKE_APP_URL, config: engineConfig(fake.engine, { video: 'on', artifacts: { store } }) },
      );
      try {
        assertValidReport(outcome.report);
        const attempt = resultByTitle(outcome, 'taps a node').attempts[0]!;
        const hosted = attempt.artifacts.find((artifact) => artifact.url === HOSTED)!;
        expect(hosted.ref).toBe('store://link/1');
        expect(links).toEqual([
          {
            kind: 'video',
            url: HOSTED,
            mediaType: 'video/mp4',
            redaction: 'incomplete',
            runId: outcome.report.run.id,
            testId: resultByTitle(outcome, 'taps a node').test.id,
            attemptId: attempt.id,
            startedAt: hosted.startedAt,
          },
        ]);
        // The file segment still goes to put, and the link never does.
        expect(puts.filter((artifact) => artifact.kind === 'video').map((artifact) => artifact.path)).toEqual([expect.stringMatching(/video\/fake\.webm$/)]);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    "never hands over a passed attempt's link under retain-on-failure, and a failing putLink fails nothing",
    async () => {
      const kept = capturingStore();
      const passed = await runProject(
        { 'tests/pass.e2e.ts': PASSING_TEST },
        {
          appUrl: FAKE_APP_URL,
          config: engineConfig(createFakeEngine({ video: true, videoLinks: [HOSTED] }).engine, { video: 'retain-on-failure', artifacts: { store: kept.store } }),
        },
      );
      expect(passed.outcome.status).toBe('passed');
      expect(kept.links).toEqual([]);
      passed.project.cleanup();

      const broken = capturingStore({ failLinks: true });
      const failing = await runProject(
        { 'tests/pass.e2e.ts': PASSING_TEST },
        {
          appUrl: FAKE_APP_URL,
          config: engineConfig(createFakeEngine({ video: true, videoLinks: [HOSTED] }).engine, { video: 'on', artifacts: { store: broken.store } }),
        },
      );
      try {
        expect(failing.outcome.status).toBe('passed');
        expect(broken.links).toHaveLength(1);
        const attempt = resultByTitle(failing.outcome, 'taps a node').attempts[0]!;
        expect(attempt.cleanup).toBe('complete');
        const hosted = attempt.artifacts.find((artifact) => artifact.url === HOSTED)!;
        expect(hosted.ref).toBeUndefined();
      } finally {
        failing.project.cleanup();
      }
    },
    60_000,
  );
});
