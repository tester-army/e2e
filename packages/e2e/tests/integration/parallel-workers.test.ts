import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerConfigSource,
  workerFakeConfigSource,
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
        { configSource: workerFakeConfigSource(2) },
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

test('without a session starts clean', async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('empty');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/auth.setup.e2e.ts': setupFile, 'tests/consumer.e2e.ts': consumerFile },
        { appUrl: app.url, configSource: workerConfigSource(2) },
      );
      expect(resultByTitle(outcome, 'seed storage').status).toBe('passed');
      expect(resultByTitle(outcome, 'starts with the seeded state').status).toBe('passed');
      expect(resultByTitle(outcome, 'without a session starts clean').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      const sessionsRoot = path.join(project.dir, '.e2e', 'sessions');
      if (existsSync(sessionsRoot)) expect(readdirSync(sessionsRoot)).toEqual([]);
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
        { configSource: workerFakeConfigSource(2) },
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
      const serialFile = `import { test } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  let shared = 0;

  test('step 1', async ({ app, screen }) => {
    await app.open();
    shared += 1;
    await screen.getByRole('button', { name: 'Submit' }).tap();
  });

  test('step 2 shares state', async ({ screen }) => {
    if (shared !== 1) throw new Error('module state was not preserved: ' + shared);
    await screen.getByRole('button', { name: 'Submit' }).tap();
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
        { configSource: workerFakeConfigSource(2) },
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
        { configSource: workerFakeConfigSource(2) },
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
      assertValidReport(JSON.parse(readFileSync(outcome.reportPath!, 'utf8')));
      project.cleanup();
    },
    120_000,
  );

  it(
    'times out a body that never calls the harness and runs the next test of its file',
    async () => {
      const file = `import { test } from 'e2e';

test('sleeps past its timeout', { timeout: 1000 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});

test('runs after the timeout', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/timeout.e2e.ts': file },
        { configSource: workerFakeConfigSource(1) },
      );
      const timedOut = resultByTitle(outcome, 'sleeps past its timeout');
      expect(timedOut.status).toBe('timed-out');
      expect(timedOut.attempts[0]?.error?.message).toContain('test timed out after 1000 ms');
      expect(resultByTitle(outcome, 'runs after the timeout').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);
      expect(outcome.report.run.errors).toEqual([]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'fails the serial member a worker crash interrupts, not only the ones after it',
    async () => {
      const file = `import { test } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  test('step 1 passes', async ({ app }) => {
    await app.open();
  });
  test('step 2 crashes the worker', async ({ app }) => {
    await app.open();
    process.exit(7);
  });
  test('step 3 never starts', async () => {});
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/serial-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('failed');
      expect(group.attempts[0]!.members.map((member) => [member.status, member.error?.code])).toEqual([
        ['passed', undefined],
        ['failed', 'WORKER_CRASH'],
        ['skipped', undefined],
      ]);
      expect(resultByTitle(outcome, 'step 1 passes').status).toBe('passed');
      const crashed = resultByTitle(outcome, 'step 2 crashes the worker');
      expect(crashed.status).toBe('failed');
      expect(crashed.serialGroupId).toBe(group.id);
      const unreached = resultByTitle(outcome, 'step 3 never starts');
      expect(unreached.status).toBe('skipped');
      expect(unreached.skip?.cause).toBe('serial-predecessor-failed');
      expect(outcome.exitCode).toBe(3);
      expect(outcome.report.run.summary.failed).toBe(1);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'keeps the failed attempt before a retry that crashed the worker',
    async () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-retry-crash-')), 'failed-once');
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('fails, then crashes on retry', { retries: 1 }, async () => {
  if (!existsSync(${JSON.stringify(marker)})) {
    writeFileSync(${JSON.stringify(marker)}, '');
    throw new Error('first attempt fails');
  }
  process.exit(7);
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/retry-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const result = resultByTitle(outcome, 'fails, then crashes on retry');
      expect(result.status).toBe('failed');
      expect(result.attempts.map((attempt) => [attempt.index, attempt.status, attempt.error?.message])).toEqual([
        [0, 'failed', 'first attempt fails'],
        [1, 'failed', 'worker process exited during this test'],
      ]);
      expect(result.attempts[1]!.error?.code).toBe('WORKER_CRASH');
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'keeps the failed group attempt before a serial retry that crashed the worker',
    async () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-serial-retry-crash-')), 'failed-once');
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test.describe('wizard', { serial: true, retries: 1 }, () => {
  test('step 1 passes', async () => {});
  test('step 2 fails, then crashes on retry', async () => {
    if (!existsSync(${JSON.stringify(marker)})) {
      writeFileSync(${JSON.stringify(marker)}, '');
      throw new Error('first attempt fails');
    }
    process.exit(7);
  });
  test('step 3 never passes', async () => {});
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/serial-retry-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('failed');
      expect(
        group.attempts.map((attempt) => [attempt.index, attempt.members.map((member) => [member.status, member.error?.code])]),
      ).toEqual([
        [0, [['passed', undefined], ['failed', 'ERROR'], ['skipped', undefined]]],
        [1, [['passed', undefined], ['failed', 'WORKER_CRASH'], ['skipped', undefined]]],
      ]);
      expect(group.attempts[0]!.members[1]!.error?.message).toBe('first attempt fails');
      expect(group.attempts[1]!.error?.code).toBe('WORKER_CRASH');
      expect(resultByTitle(outcome, 'step 1 passes').status).toBe('passed');
      const crashed = resultByTitle(outcome, 'step 2 fails, then crashes on retry');
      expect(crashed.status).toBe('failed');
      expect(crashed.serialGroupId).toBe(group.id);
      expect(resultByTitle(outcome, 'step 3 never passes').skip?.cause).toBe('serial-predecessor-failed');
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'records a crash in afterAll after a failed attempt on that attempt, not as a retry',
    async () => {
      const file = `import { test } from 'e2e';

test.afterAll(() => {
  process.exit(7);
});

test('always fails', { retries: 1 }, async () => {
  throw new Error('fails every time');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/teardown-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const result = resultByTitle(outcome, 'always fails');
      expect(result.status).toBe('failed');
      expect(result.attempts.map((attempt) => [attempt.index, attempt.error?.message, attempt.cleanup])).toEqual([
        [0, 'fails every time', 'forced'],
      ]);
      expect(result.attempts[0]!.secondaryErrors.map((error) => error.code)).toEqual(['WORKER_CRASH']);
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'keeps a passed setup attempt when afterAll crashes the worker, and skips its dependents',
    async () => {
      const setupFile = `import { test } from 'e2e';

test.afterAll(() => {
  process.exit(7);
});

test.setup('seed storage', { sessions: ['seeded'] }, async ({ app, session }) => {
  await app.open('/storage');
  await session.save('seeded');
});
`;
      const consumerFile = `import { test } from 'e2e';

test('starts with the seeded state', { session: 'seeded' }, async ({ app }) => {
  await app.open('/storage');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/auth.setup.e2e.ts': setupFile, 'tests/consumer.e2e.ts': consumerFile },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const setup = resultByTitle(outcome, 'seed storage');
      expect(setup.status).toBe('passed');
      expect(setup.attempts.map((attempt) => [attempt.index, attempt.status, attempt.cleanup])).toEqual([
        [0, 'passed', 'forced'],
      ]);
      expect(setup.attempts[0]!.secondaryErrors.map((error) => error.code)).toEqual(['WORKER_CRASH']);
      expect(resultByTitle(outcome, 'starts with the seeded state').skip?.cause).toBe('setup-failed');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'keeps the SESSION_CONTRACT failure of a setup attempt when afterAll crashes the worker',
    async () => {
      const setupFile = `import { test } from 'e2e';

test.afterAll(() => {
  process.exit(7);
});

test.setup('never saves', { sessions: ['seeded'] }, async ({ app }) => {
  await app.open('/storage');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/auth.setup.e2e.ts': setupFile,
          'tests/consumer.e2e.ts': `import { test } from 'e2e';

test('starts with the seeded state', { session: 'seeded' }, async ({ app }) => {
  await app.open('/storage');
});
`,
        },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const setup = resultByTitle(outcome, 'never saves');
      expect(setup.status).toBe('failed');
      expect(setup.attempts.map((attempt) => [attempt.index, attempt.error?.code, attempt.cleanup])).toEqual([
        [0, 'SESSION_CONTRACT', 'forced'],
      ]);
      expect(setup.attempts[0]!.secondaryErrors.map((error) => error.code)).toEqual(['WORKER_CRASH']);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'charges a crash in a retry beforeAll to the retry, not to the attempt before it',
    async () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-retry-hook-crash-')), 'failed-once');
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test.beforeAll(() => {
  if (existsSync(${JSON.stringify(marker)})) process.exit(7);
});

test('fails once', { retries: 1 }, async () => {
  writeFileSync(${JSON.stringify(marker)}, '');
  throw new Error('first attempt fails');
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/retry-hook-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const result = resultByTitle(outcome, 'fails once');
      expect(result.status).toBe('failed');
      expect(result.attempts.map((attempt) => [attempt.index, attempt.error?.code, attempt.secondaryErrors.length])).toEqual([
        [0, 'ERROR', 0],
        [1, 'WORKER_CRASH', 0],
      ]);
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'fails the first member when a serial retry crashes the worker before any member runs',
    async () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-serial-retry-hook-crash-')), 'failed-once');
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test.describe('wizard', { serial: true, retries: 1 }, () => {
  test.beforeAll(() => {
    if (existsSync(${JSON.stringify(marker)})) process.exit(7);
  });
  test('step 1 passes', async () => {});
  test('step 2 fails once', async () => {
    writeFileSync(${JSON.stringify(marker)}, '');
    throw new Error('first attempt fails');
  });
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/serial-retry-hook-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('failed');
      expect(
        group.attempts.map((attempt) => [attempt.index, attempt.error?.code, attempt.members.map((member) => [member.status, member.error?.code])]),
      ).toEqual([
        [0, 'ERROR', [['passed', undefined], ['failed', 'ERROR']]],
        [1, 'WORKER_CRASH', [['failed', 'WORKER_CRASH'], ['skipped', undefined]]],
      ]);
      // The retry never reached its members, so they keep attempt 0's verdicts.
      expect(resultByTitle(outcome, 'step 1 passes').status).toBe('passed');
      expect(resultByTitle(outcome, 'step 2 fails once').status).toBe('failed');
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'charges a crash after the last serial member to the group attempt, not to a member',
    async () => {
      const file = `import { test } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  test.afterAll(() => {
    process.exit(7);
  });
  test('step 1 passes', async () => {});
  test('step 2 passes', async () => {});
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/serial-teardown-crash.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1) },
      );
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('failed');
      expect(group.attempts).toHaveLength(1);
      expect(group.attempts[0]!.error?.code).toBe('WORKER_CRASH');
      expect(group.attempts[0]!.members.map((member) => member.status)).toEqual(['passed', 'passed']);
      expect(resultByTitle(outcome, 'step 1 passes').status).toBe('passed');
      expect(resultByTitle(outcome, 'step 2 passes').status).toBe('passed');
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'times out a test that blocks its worker, kills the worker, and runs the rest of the file on a fresh one',
    async () => {
      const file = `import { test } from 'e2e';

test('blocks the event loop at once', { timeout: 1000 }, () => {
  while (true) {}
});

test('blocks the event loop after a step', { timeout: 1000 }, async ({ app }) => {
  await app.open();
  while (true) {}
});

test('runs after the blocked tests', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/busy.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1, '\n  cleanupTimeout: 1000,') },
      );
      for (const title of ['blocks the event loop at once', 'blocks the event loop after a step']) {
        const blocked = resultByTitle(outcome, title);
        expect(blocked.status).toBe('timed-out');
        expect(blocked.attempts).toHaveLength(1);
        expect(blocked.attempts[0]?.status).toBe('timed-out');
        expect(blocked.attempts[0]?.error?.code).toBe('TEST_TIMEOUT');
      }
      expect(resultByTitle(outcome, 'runs after the blocked tests').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);
      expect(outcome.report.run.errors).toEqual([]);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'keeps the failed attempt before a retry that blocked its worker, and runs the next test',
    async () => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-retry-hang-')), 'failed-once');
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('fails, then blocks on retry', { retries: 1, timeout: 1000 }, () => {
  if (!existsSync(${JSON.stringify(marker)})) {
    writeFileSync(${JSON.stringify(marker)}, '');
    throw new Error('first attempt fails');
  }
  while (true) {}
});

test('runs after the blocked retry', async () => {});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/retry-hang.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1, '\n  cleanupTimeout: 1000,') },
      );
      const result = resultByTitle(outcome, 'fails, then blocks on retry');
      expect(result.status).toBe('timed-out');
      expect(result.attempts.map((attempt) => [attempt.index, attempt.status, attempt.error?.code])).toEqual([
        [0, 'failed', 'ERROR'],
        [1, 'timed-out', 'TEST_TIMEOUT'],
      ]);
      expect(result.attempts[0]!.error?.message).toBe('first attempt fails');
      expect(resultByTitle(outcome, 'runs after the blocked retry').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);
      expect(outcome.report.run.errors).toEqual([]);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'leaves a worker that still answers alone while a timed-out test tears down past the watchdog window',
    async () => {
      // Seven teardowns of 900 ms each keep the attempt going about 6 s past
      // its timeout, longer than the 5 s the worker gets to answer a ping.
      const file = `import { test } from 'e2e';

for (let hook = 0; hook < 7; hook += 1) {
  test.afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
}

test('times out and tears down slowly', { timeout: 1000 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/slow-teardown.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1, '\n  cleanupTimeout: 1000,') },
      );
      const result = resultByTitle(outcome, 'times out and tears down slowly');
      expect(result.status).toBe('timed-out');
      const attempt = result.attempts[0]!;
      expect(attempt.error?.message).toBe('test timed out after 1000 ms in phase body');
      expect(attempt.cleanup).toBe('complete');
      expect(attempt.steps.map((step) => step.api)).toContain('app.open');
      expect(attempt.durationMs).toBeGreaterThan(6_000);
      project.cleanup();
    },
    60_000,
  );

  it(
    'times out a serial member that blocks its worker right after the member before it, skipping the rest of its group',
    async () => {
      const file = `import { test } from 'e2e';

test.describe('group', { serial: true }, () => {
  test('first member', async () => {});
  test('second member blocks', { timeout: 1000 }, () => {
    while (true) {}
  });
  test('third member', async () => {});
});

test('outside the group', async () => {});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/serial-busy.e2e.ts': file },
        { appUrl: app.url, configSource: workerConfigSource(1, '\n  cleanupTimeout: 1000,') },
      );
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('timed-out');
      expect(
        group.attempts.map((attempt) => [attempt.status, attempt.members.map((member) => [member.status, member.error?.code])]),
      ).toEqual([['timed-out', [['passed', undefined], ['timed-out', 'TEST_TIMEOUT'], ['skipped', undefined]]]]);
      expect(resultByTitle(outcome, 'first member').status).toBe('passed');
      expect(resultByTitle(outcome, 'second member blocks').status).toBe('timed-out');
      expect(resultByTitle(outcome, 'third member').skip?.cause).toBe('serial-predecessor-failed');
      expect(resultByTitle(outcome, 'outside the group').status).toBe('passed');
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(1);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
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
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/slow.e2e.ts': slowFile, 'tests/unstarted.e2e.ts': queuedFile },
        {
          configSource: workerFakeConfigSource(1),
          runOptions: {
            interruptSignal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'test-started') controller.abort();
            },
          },
        },
      );
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

  it(
    'stops at --max-failures inside the running file: the worker starts none of its tests after the limit',
    async () => {
      const file = `import { test } from 'e2e';

test('fails first', async ({ app }) => {
  await app.open();
  throw new Error('one');
});
test('would run next', async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
});
test('would run last', async () => {});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/limit.e2e.ts': file },
        { configSource: workerFakeConfigSource(1), runOptions: { maxFailures: 1 } },
      );
      expect(outcome.exitCode).toBe(1);
      const byDeclaration = outcome.results.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
      expect(byDeclaration.map((result) => [result.test.title, result.status, result.skip?.cause, result.attempts.length])).toEqual([
        ['fails first', 'failed', undefined, 1],
        ['would run next', 'skipped', 'failure-limit', 0],
        ['would run last', 'skipped', 'failure-limit', 0],
      ]);
      expect(byDeclaration[1]!.skip?.reason).toBe('run stopped after 1 failure (--max-failures 1)');
      expect(outcome.report.run.summary).toMatchObject({ failed: 1, skipped: 2 });
      assertValidReport(outcome.report);
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
          // Every worker resolves its own project id, so none agrees with the runner's digest.
          configSource: workerFakeConfigSource(4, "\n  projectId: 'p-' + Math.random().toString(36).slice(2),"),
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
        { configSource: workerFakeConfigSource(1) },
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
      const leakingFile = `import { existsSync } from 'node:fs';
import { test } from 'e2e';

test('leaves a timer behind', async ({ app }) => {
  await app.open();
  const marker = new URL('./running', import.meta.url);
  const timer = setInterval(() => {
    if (!existsSync(marker)) return;
    clearInterval(timer);
    void Promise.reject(new Error('late'));
  }, 20);
});
`;
      const sleepingFile = `import { writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('is running when it surfaces', async ({ app }) => {
  await app.open();
  writeFileSync(new URL('./running', import.meta.url), '');
  await new Promise((resolve) => setTimeout(resolve, 2_000));
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/a-leaks.e2e.ts': leakingFile, 'tests/b-sleeps.e2e.ts': sleepingFile },
        { configSource: workerFakeConfigSource(1) },
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
        { configSource: workerFakeConfigSource(1) },
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

  it(
    'keeps the body failure as the verdict when a rejection surfaces after it',
    async () => {
      const file = `import { test } from 'e2e';

test('fails twice', async ({ app }) => {
  await app.open();
  void Promise.reject(new Error('second'));
  throw new Error('first');
});

test('runs after both', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/twice.e2e.ts': file },
        { configSource: workerFakeConfigSource(1) },
      );
      const attempt = resultByTitle(outcome, 'fails twice').attempts[0]!;
      expect(attempt.status).toBe('failed');
      expect(attempt.error).toMatchObject({ message: 'first', phase: 'body' });
      expect(attempt.secondaryErrors.map((error) => [error.message, error.phase])).toEqual([['second', 'body']]);
      expect(resultByTitle(outcome, 'runs after both').status).toBe('passed');
      expect(outcome.exitCode).toBe(1);

      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      expect(run['errors']).toEqual([]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'records a worker fatal once, without a WORKER_EXIT for the kill it asked for',
    async () => {
      const file = `import { test } from 'e2e';

test('throws off the stack', async ({ app }) => {
  await app.open();
  setTimeout(() => {
    throw new Error('boom-uncaught');
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('never starts', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/fatal.e2e.ts': file },
        { configSource: workerFakeConfigSource(1) },
      );
      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const errors = run['errors'] as Record<string, unknown>[];
      expect(errors.filter((error) => String(error['message']).includes('boom-uncaught'))).toHaveLength(1);
      expect(errors.map((error) => error['code'])).not.toContain('WORKER_EXIT');
      const crashed = resultByTitle(outcome, 'throws off the stack');
      expect(crashed.status).toBe('failed');
      expect(crashed.attempts[0]?.error?.code).toBe('WORKER_CRASH');
      const skipped = resultByTitle(outcome, 'never starts');
      expect(skipped.status).toBe('skipped');
      expect(skipped.skip?.cause).toBe('infrastructure-unavailable');
      expect(outcome.exitCode).toBe(3);
      project.cleanup();
    },
    120_000,
  );

  it(
    'ends the worker on a rejection before any test has finished in it',
    async () => {
      const earlyFile = `import { test } from 'e2e';

test.beforeAll(async () => {
  void Promise.reject(new Error('early'));
  await new Promise((resolve) => setTimeout(resolve, 500));
});

test('is on its way when it surfaces', async ({ app }) => {
  await app.open();
});

test('follows in the same file', async ({ app }) => {
  await app.open();
});
`;
      const nextFile = `import { test } from 'e2e';

test('runs on the next worker', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/a-early.e2e.ts': earlyFile, 'tests/b-next.e2e.ts': nextFile },
        { configSource: workerFakeConfigSource(1) },
      );
      const run = outcome.report['run'] as unknown as Record<string, unknown>;
      const errors = run['errors'] as Record<string, unknown>[];
      expect(errors.map((error) => [error['code'], error['message']])).toEqual([['ERROR', 'early']]);
      // A beforeAll runs on the way to the file's first test, which is the pair in flight.
      const crashed = resultByTitle(outcome, 'is on its way when it surfaces');
      expect(crashed.status).toBe('failed');
      expect(crashed.attempts[0]?.error?.code).toBe('WORKER_CRASH');
      const skipped = resultByTitle(outcome, 'follows in the same file');
      expect(skipped.status).toBe('skipped');
      expect(skipped.skip?.cause).toBe('infrastructure-unavailable');
      expect(resultByTitle(outcome, 'runs on the next worker').status).toBe('passed');
      expect(outcome.exitCode).toBe(3);
      project.cleanup();
    },
    120_000,
  );
});
