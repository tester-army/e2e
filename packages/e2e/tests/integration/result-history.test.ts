import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFakeEngine, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { contentsUnder, createProject, resultByTitle, runExisting, runExistingWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

const FAILURE = `import { test } from 'e2e';
test('fails on purpose', async ({ app }) => {
  await app.open('/');
  throw new Error('retained failure evidence');
});
`;

it('retains the report, traces and artifact bytes across full runs, then prunes the oldest snapshot', async () => {
  const project = createProject({ 'tests/probe.e2e.ts': FAILURE });
  try {
    const config = engineConfig(createFakeEngine({ artifacts: true }).engine, { keepResults: 2, trace: 'on' });
    const output = path.join(project.dir, '.e2e');
    const first = await runExisting(project, { appUrl: FAKE_APP_URL, config });
    expect(first.exitCode).toBe(1);
    const firstId = first.report.run.id;
    const archived = path.join(output, 'history', firstId);
    const savedReport = readFileSync(path.join(archived, 'report.json'), 'utf8');
    assertValidReport(JSON.parse(savedReport));
    expect(savedReport).toBe(readFileSync(path.join(output, 'report.json'), 'utf8'));
    const shot = resultByTitle(first, 'fails on purpose').attempts[0]!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
    const savedShot = readFileSync(path.join(archived, 'results', shot.path!));
    const traceDir = shot.path!.split('/')[0]!;
    const trace = readFileSync(path.join(archived, 'results', traceDir, 'trace.md'), 'utf8');
    expect(trace).toContain('retained failure evidence');
    expect(trace).toContain(`.e2e/history/${firstId}/results/`);
    expect(trace).not.toContain('.pending-');

    writeFileSync(path.join(project.dir, 'tests/probe.e2e.ts'), "import { test } from 'e2e'; test('now passes', async () => {});\n");
    const second = await runExisting(project, { appUrl: FAKE_APP_URL, config });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(path.join(archived, 'report.json'), 'utf8')).toBe(savedReport);
    expect(readFileSync(path.join(archived, 'results', shot.path!))).toEqual(savedShot);
    expect(existsSync(path.join(output, 'results', shot.path!))).toBe(false);

    const third = await runExisting(project, { appUrl: FAKE_APP_URL, config });
    expect(third.exitCode).toBe(0);
    const runs = readdirSync(path.join(output, 'history')).filter((name) => !name.startsWith('.'));
    expect(runs.toSorted()).toEqual([second.report.run.id, third.report.run.id].toSorted());
    expect(existsSync(archived)).toBe(false);
  } finally {
    project.cleanup();
  }
});

it('keeps default clearing behavior and leaves existing history untouched when disabled', async () => {
  const project = createProject({ 'tests/probe.e2e.ts': FAILURE });
  try {
    const config = engineConfig(createFakeEngine({ artifacts: true }).engine);
    const first = await runExisting(project, { appUrl: FAKE_APP_URL, config });
    expect(first.exitCode).toBe(1);
    const history = path.join(project.dir, '.e2e/history');
    expect(existsSync(history)).toBe(false);
    const enabled = await runExisting(project, { appUrl: FAKE_APP_URL, config: { ...config, keepResults: 1 } });
    expect(enabled.exitCode).toBe(1);
    const before = readdirSync(history);
    await runExisting(project, { appUrl: FAKE_APP_URL, config: { ...config, keepResults: 0 } });
    expect(readdirSync(history)).toEqual(before);
    writeFileSync(path.join(project.dir, 'tests/broken.e2e.ts'), "throw new Error('cannot collect');\n");
    const broken = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { files: ['tests/broken.e2e.ts'] } });
    expect(broken.exitCode).toBe(2);
    expect(readdirSync(history)).toEqual(before);
  } finally {
    project.cleanup();
  }
});

it('snapshots a run interrupted after tests start', async () => {
  const project = createProject({
    'tests/probe.e2e.ts': "import { test } from 'e2e'; test('waits', async () => { await new Promise(() => {}); });\n",
    'e2e.config.ts': workerFakeConfigSource(1, ' keepResults: 2, cleanupTimeout: 1000,'),
  });
  try {
    const controller = new AbortController();
    const outcome = await runExistingWithConfigFile(project, {
      runOptions: {
        interruptSignal: controller.signal,
        onEvent: (event) => { if (event.type === 'test-started') controller.abort(); },
      },
    });
    expect(outcome.exitCode).toBe(130);
    const saved = path.join(project.dir, '.e2e/history', outcome.report.run.id, 'report.json');
    expect(JSON.parse(readFileSync(saved, 'utf8')).run.status).toBe('interrupted');
  } finally {
    project.cleanup();
  }
});

it('writes history under the CLI output override and keeps registered secrets redacted in every copy', async () => {
  const secret = 'history-probe-K7zV9xQ2';
  const project = createProject({
    'tests/probe.e2e.ts': `import { test } from 'e2e'; test('secret failure', async () => { throw new Error(${JSON.stringify(secret)}); });`,
  });
  try {
    const config = engineConfig(createFakeEngine().engine, { keepResults: 2, secrets: { probe: secret } });
    const outcome = await runExisting(project, { config, runOptions: { output: 'custom-output' } });
    expect(outcome.exitCode).toBe(1);
    const output = path.join(project.dir, 'custom-output');
    expect(existsSync(path.join(output, 'history', outcome.report.run.id, 'report.json'))).toBe(true);
    expect(existsSync(path.join(project.dir, '.e2e/history'))).toBe(false);
    for (const [file, content] of contentsUnder(output)) expect(content, file).not.toContain(secret);
    expect(readFileSync(path.join(output, 'history', outcome.report.run.id, 'report.json'), 'utf8')).toContain('<secret:probe>');
  } finally {
    project.cleanup();
  }
});

it('prints a history error without replacing the canonical report or the test verdict', async () => {
  const project = createProject({ 'tests/probe.e2e.ts': FAILURE, '.e2e/history/notes.txt': 'owned by the user' });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const config = engineConfig(createFakeEngine().engine, { keepResults: 2 });
    const outcome = await runExisting(project, { appUrl: FAKE_APP_URL, config });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.run.errors).toEqual([]);
    expect(readFileSync(outcome.reportPath!, 'utf8')).toBe(JSON.stringify(outcome.report, null, 2) + '\n');
    expect(readFileSync(path.join(project.dir, '.e2e/history/notes.txt'), 'utf8')).toBe('owned by the user');
    expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('run history could not be saved');
  } finally {
    stderr.mockRestore();
    project.cleanup();
  }
});

it('does not archive or prune when no tests start, and keeps last-failed artifact paths intact', async () => {
  const project = createProject({ 'tests/probe.e2e.ts': FAILURE });
  try {
    const config = engineConfig(createFakeEngine({ artifacts: true }).engine, { keepResults: 2 });
    const first = await runExisting(project, { appUrl: FAKE_APP_URL, config });
    expect(first.exitCode).toBe(1);
    const history = path.join(project.dir, '.e2e/history');
    const before = readdirSync(history);
    const none = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { grep: [/not a test/] } });
    expect(none.exitCode).toBe(2);
    expect(readdirSync(history)).toEqual(before);
    const rerun = await runExisting(project, { appUrl: FAKE_APP_URL, config, runOptions: { lastFailed: true } });
    expect(rerun.exitCode).toBe(1);
    const shot = resultByTitle(rerun, 'fails on purpose').attempts[0]!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
    expect(shot.path).toContain('/rerun-1/');
    expect(existsSync(path.join(history, rerun.report.run.id, 'results', shot.path!))).toBe(true);
    expect(existsSync(path.join(history, first.report.run.id, 'report.json'))).toBe(true);
  } finally {
    project.cleanup();
  }
});
