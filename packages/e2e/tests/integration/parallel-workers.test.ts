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
    'interrupts workers, reports 130, and lists the file the one worker never reached',
    async () => {
      const slowFile = `import { test } from 'e2e';

test('sleeps a long time', { timeout: 8000 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;
      const queuedFile = `import { test } from 'e2e';

test('waits in the queue', async () => {});
`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/slow.e2e.ts': slowFile, 'tests/unstarted.e2e.ts': queuedFile },
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
      const unstarted = resultByTitle(outcome, 'waits in the queue');
      expect(unstarted.status).toBe('skipped');
      expect(unstarted.skip).toEqual({ cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' });
      expect(outcome.report.run.summary.discovered).toBe(2);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );
});
