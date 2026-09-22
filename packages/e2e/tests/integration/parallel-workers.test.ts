import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerConfigSource,
} from '../helpers/run-project.ts';

describe('parallel worker execution', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'executes file units on separate worker processes',
    async () => {
      const pidDir = mkdtempSync(path.join(tmpdir(), 'e2e-pids-'));
      const testFile = (name: string) => `import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'e2e';

test('${name} runs', async ({ app }) => {
  await app.open();
  writeFileSync(path.join(${JSON.stringify(pidDir)}, '${name}-' + process.pid), 'ok');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/one.e2e.ts': testFile('one'), 'tests/two.e2e.ts': testFile('two') },
        { appUrl: app.url, configSource: workerConfigSource(2) },
      );
      expect(resultByTitle(outcome, 'one runs').status).toBe('passed');
      expect(resultByTitle(outcome, 'two runs').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);

      const pids = new Set(
        readdirSync(pidDir).map((entry) => entry.slice(entry.lastIndexOf('-') + 1)),
      );
      expect(pids.size).toBe(2);
      expect(pids.has(String(process.pid))).toBe(false);

      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'produces sessions in one worker and restores them in another',
    async () => {
      const setupFile = `import { test, expect } from 'e2e';

test.setup('seed storage', { sessions: ['seeded'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await screen.getByRole('button', { name: 'Save marker' }).tap();
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  await session.save('seeded');
});
`;
      const consumerFile = `import { test, expect } from 'e2e';

test('starts with the seeded state', { session: 'seeded' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/auth.setup.e2e.ts': setupFile, 'tests/consumer.e2e.ts': consumerFile },
        { appUrl: app.url, configSource: workerConfigSource(2) },
      );
      expect(resultByTitle(outcome, 'seed storage').status).toBe('passed');
      expect(resultByTitle(outcome, 'starts with the seeded state').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      project.cleanup();
    },
    120_000,
  );

  it(
    'gates dependents across workers when their setup fails',
    async () => {
      const setupFile = `import { test } from 'e2e';

test.setup('failing setup', { sessions: ['broken'] }, async ({ app }) => {
  await app.open();
  throw new Error('cannot authenticate');
});
`;
      const dependentFile = `import { test } from 'e2e';

test('depends on broken', { session: 'broken' }, async ({ app }) => {
  await app.open();
});
`;
      const unrelatedFile = `import { test } from 'e2e';

test('unrelated still runs', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/auth.setup.e2e.ts': setupFile,
          'tests/dependent.e2e.ts': dependentFile,
          'tests/unrelated.e2e.ts': unrelatedFile,
        },
        { appUrl: app.url, configSource: workerConfigSource(2) },
      );
      const dependent = resultByTitle(outcome, 'depends on broken');
      expect(dependent.status).toBe('skipped');
      expect(dependent.skip?.cause).toBe('setup-failed');
      expect(resultByTitle(outcome, 'unrelated still runs').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );

  it(
    'runs serial groups as one unit on one worker',
    async () => {
      const serialFile = `import { test, expect } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  let shared = 0;

  test('step 1', async ({ app, screen }) => {
    await app.open();
    shared += 1;
    await screen.getByRole('button', { name: 'Increment' }).tap();
    await expect(screen.getByRole('status')).toHaveText('1');
  });

  test('step 2 shares state', async ({ screen }) => {
    if (shared !== 1) throw new Error('module state was not preserved: ' + shared);
    await screen.getByRole('button', { name: 'Increment' }).tap();
  });
});
`;
      const otherFile = `import { test } from 'e2e';

test('parallel neighbor', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/wizard.e2e.ts': serialFile, 'tests/other.e2e.ts': otherFile },
        { appUrl: app.url, configSource: workerConfigSource(2) },
      );
      expect(resultByTitle(outcome, 'step 1').status).toBe('passed');
      expect(resultByTitle(outcome, 'step 2 shares state').status).toBe('passed');
      expect(resultByTitle(outcome, 'parallel neighbor').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);

      assertValidReport(outcome.report);
      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const groups = run['serialGroups'] as Record<string, unknown>[];
      expect(groups).toHaveLength(1);
      expect(groups[0]!['status']).toBe('passed');
      project.cleanup();
    },
    120_000,
  );

  it(
    'reports a worker crash as infrastructure failure and finishes the run',
    async () => {
      const crashFile = `import { test } from 'e2e';

test('crashes the worker', async ({ app }) => {
  await app.open();
  process.exit(7);
});

test('never reached in this file', async ({ app }) => {
  await app.open();
});
`;
      const survivorFile = `import { test } from 'e2e';

test('survivor passes', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/crash.e2e.ts': crashFile, 'tests/survivor.e2e.ts': survivorFile },
        { appUrl: app.url, configSource: workerConfigSource(2) },
      );
      const crashed = resultByTitle(outcome, 'crashes the worker');
      expect(crashed.status).toBe('failed');
      expect(crashed.attempts[0]?.error?.code).toBe('WORKER_CRASH');
      const unreached = resultByTitle(outcome, 'never reached in this file');
      expect(unreached.status).toBe('skipped');
      expect(unreached.skip?.cause).toBe('infrastructure-unavailable');
      expect(resultByTitle(outcome, 'survivor passes').status).toBe('passed');
      expect(outcome.exitCode).not.toBe(0);

      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const errors = run['errors'] as Record<string, unknown>[];
      expect(errors.some((error) => error['code'] === 'WORKER_EXIT')).toBe(true);
      project.cleanup();
    },
    120_000,
  );

  it(
    'interrupts workers and reports 130',
    async () => {
      const slowFile = `import { test } from 'e2e';

test('sleeps a long time', { timeout: 8000 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/slow.e2e.ts': slowFile },
        {
          appUrl: app.url,
          configSource: workerConfigSource(1),
          runOptions: { interruptSignal: controller.signal },
        },
      );
      clearTimeout(timer);
      expect(outcome.exitCode).toBe(130);
      expect(outcome.status).toBe('interrupted');
      const result = resultByTitle(outcome, 'sleeps a long time');
      // The body is a plain sleep that never calls the harness: the interrupt
      // still ends the attempt at once, well before the 8 s test timeout.
      expect(['interrupted', 'skipped']).toContain(result.status);
      project.cleanup();
    },
    120_000,
  );

  it(
    'reports a target whose workers cannot boot once, whatever the worker count',
    async () => {
      const testFile = (name: string) => `import { test } from 'e2e';

test('${name} never runs', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        Object.fromEntries(['one', 'two', 'three', 'four'].map((name) => [`tests/${name}.e2e.ts`, testFile(name)])),
        {
          appUrl: app.url,
          // Every worker resolves its own project id, so none agrees with the runner's digest.
          configSource: workerConfigSource(4, "\n  projectId: 'p-' + Math.random().toString(36).slice(2),"),
        },
      );
      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const errors = run['errors'] as Record<string, unknown>[];
      expect(errors.filter((error) => error['code'] === 'WORKER_INIT_FAILED')).toHaveLength(1);
      expect(errors.some((error) => error['code'] === 'CONFIG_NOT_DETERMINISTIC')).toBe(true);
      for (const name of ['one', 'two', 'three', 'four']) {
        const result = resultByTitle(outcome, `${name} never runs`);
        expect(result.status).toBe('skipped');
        expect(result.skip?.cause).toBe('infrastructure-unavailable');
      }
      expect(outcome.exitCode).not.toBe(0);
      project.cleanup();
    },
    120_000,
  );

  it(
    'fails the test that rejected a promise it never awaited, and runs the rest of its file',
    async () => {
      const strayFile = `import { test } from 'e2e';

test('leaves a rejection behind', async ({ app }) => {
  await app.open();
  void Promise.reject(new Error('boom'));
});

test('runs after the rejection', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/stray.e2e.ts': strayFile },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const stray = resultByTitle(outcome, 'leaves a rejection behind');
      expect(stray.status).toBe('failed');
      expect(stray.attempts[0]?.error?.message).toBe('boom');
      expect(resultByTitle(outcome, 'runs after the rejection').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);

      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const errors = run['errors'] as Record<string, unknown>[];
      expect(errors).toEqual([]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'charges a rejection that surfaces late to the test running at the time',
    async () => {
      const leakingFile = `import { test } from 'e2e';

test('leaves a timer behind', async ({ app }) => {
  await app.open();
  setTimeout(() => {
    void Promise.reject(new Error('late'));
  }, 1_500);
});
`;
      const sleepingFile = `import { test } from 'e2e';

test('is running when it surfaces', async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 6_000));
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/a-leaks.e2e.ts': leakingFile, 'tests/b-sleeps.e2e.ts': sleepingFile },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      expect(resultByTitle(outcome, 'leaves a timer behind').status).toBe('passed');
      const charged = resultByTitle(outcome, 'is running when it surfaces');
      expect(charged.status).toBe('failed');
      expect(charged.attempts[0]?.error?.message).toBe('late');
      expect(outcome.exitCode).toBe(1);

      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      expect(run['errors']).toEqual([]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'records a rejection between tests as a run error naming the last test that finished',
    async () => {
      const leakingFile = `import { test } from 'e2e';

test('finishes before the leak', async ({ app }) => {
  await app.open();
});

test.afterAll(() => {
  void Promise.reject(new Error('late'));
});
`;
      const nextFile = `import { test } from 'e2e';

test('runs on the same worker afterwards', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/a-leaks.e2e.ts': leakingFile, 'tests/b-next.e2e.ts': nextFile },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const finished = resultByTitle(outcome, 'finishes before the leak');
      expect(finished.status).toBe('passed');
      expect(resultByTitle(outcome, 'runs on the same worker afterwards').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);

      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const errors = run['errors'] as Record<string, unknown>[];
      expect(errors.map((error) => error['code'])).toEqual(['UNHANDLED_REJECTION']);
      expect(errors[0]?.['message']).toContain(`"${finished.test.id}"`);
      expect(errors[0]?.['message']).toContain('late');
      project.cleanup();
    },
    120_000,
  );
});
