import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('runner lifecycle', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'runs hooks in specification order',
    async () => {
      const hooksFile = `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeAll(() => log('beforeAll:file'));
test.afterAll(() => log('afterAll:file'));
test.beforeEach(() => log('beforeEach:file'));
test.afterEach(() => log('afterEach:file'));

test.describe('group', () => {
  test.beforeAll(() => log('beforeAll:group'));
  test.afterAll(() => log('afterAll:group'));
  test.beforeEach(() => log('beforeEach:group'));
  test.afterEach(() => log('afterEach:group'));

  test('inside group', async ({ platform }) => {
    log('body:' + platform);
  });
});
`;
      const logPath = path.join('/tmp', `e2e-hooks-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject(
        { 'tests/hooks.e2e.ts': hooksFile },
        { appUrl: app.url },
      );
      expect(resultByTitle(outcome, 'inside group').status).toBe('passed');
      const entries = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(entries).toEqual([
        'beforeAll:file',
        'beforeAll:group',
        'beforeEach:file',
        'beforeEach:group',
        'body:web',
        'afterEach:group',
        'afterEach:file',
        'afterAll:group',
        'afterAll:file',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'skips scope tests when beforeAll fails and reports hook-failed',
    async () => {
      const file = `import { test } from 'e2e';

test.describe('broken scope', () => {
  test.beforeAll(() => {
    throw new Error('suite setup exploded');
  });
  test('unreachable', async () => {});
});

test('independent survives', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProject({ 'tests/hookfail.e2e.ts': file }, { appUrl: app.url });
      const skipped = resultByTitle(outcome, 'unreachable');
      expect(skipped.status).toBe('skipped');
      expect(skipped.skip?.cause).toBe('hook-failed');
      expect(resultByTitle(outcome, 'independent survives').status).toBe('passed');
      expect(outcome.exitCode).not.toBe(0);
      project.cleanup();
    },
    120_000,
  );

  it(
    'retries failed attempts in fresh realms and reports flaky',
    async () => {
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('flaky test', { retries: 2 }, async ({ app }) => {
  await app.open();
  const marker = process.env.FLAKY_MARKER!;
  if (!existsSync(marker)) {
    writeFileSync(marker, 'attempted');
    throw new Error('first attempt fails');
  }
});
`;
      const marker = path.join('/tmp', `e2e-flaky-${Date.now()}`);
      process.env['FLAKY_MARKER'] = marker;
      const { outcome, project } = await runProject({ 'tests/flaky.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'flaky test');
      expect(result.status).toBe('flaky');
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0]!.status).toBe('failed');
      expect(result.attempts[1]!.status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      project.cleanup();
    },
    120_000,
  );

  it(
    'times out slow tests and still reports afterward',
    async () => {
      const file = `import { test } from 'e2e';

test('sleeps forever', { timeout: 1500 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;
      const { outcome, project } = await runProject({ 'tests/slow.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'sleeps forever');
      expect(result.status).toBe('timed-out');
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );

  it(
    'produces sessions in setup tests and restores them for consumers',
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

test('starts with the seeded state', { session: 'seeded' }, async ({ app, screen, web }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  const cookies = await web.cookies();
  if (!cookies.some((cookie) => cookie.name === 'fixture')) {
    throw new Error('expected the fixture cookie from the session');
  }
});

test('without a session starts clean', async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('empty');
});
`;
      const { outcome, project } = await runProject(
        { 'tests/auth.setup.e2e.ts': setupFile, 'tests/consumer.e2e.ts': consumerFile },
        { appUrl: app.url },
      );
      expect(resultByTitle(outcome, 'seed storage').status).toBe('passed');
      expect(resultByTitle(outcome, 'starts with the seeded state').status).toBe('passed');
      expect(resultByTitle(outcome, 'without a session starts clean').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      const sessionsRoot = path.join(project.dir, '.e2e', 'sessions');
      if (existsSync(sessionsRoot)) {
        expect(readdirSync(sessionsRoot)).toEqual([]);
      }
      project.cleanup();
    },
    120_000,
  );

  it(
    'skips session consumers when their setup fails',
    async () => {
      const file = `import { test } from 'e2e';

test.setup('failing setup', { sessions: ['broken'] }, async ({ app }) => {
  await app.open();
  throw new Error('cannot authenticate');
});

test('depends on broken', { session: 'broken' }, async ({ app }) => {
  await app.open();
});

test('unrelated still runs', async ({ app }) => {
  await app.open();
});
`;
      const { outcome, project } = await runProject({ 'tests/dep.e2e.ts': file }, { appUrl: app.url });
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
    'runs serial groups as one unit with shared state and predecessor skips',
    async () => {
      const file = `import { test, expect } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  let shared = 0;

  test('step 1 increments', async ({ app, screen }) => {
    await app.open();
    shared += 1;
    await screen.getByRole('button', { name: 'Increment' }).tap();
    await expect(screen.getByRole('status')).toHaveText('1');
  });

  test('step 2 sees shared module and app state', async ({ screen, app }) => {
    if (shared !== 1) throw new Error('module state was not preserved: ' + shared);
    await app.open();
    await screen.getByRole('button', { name: 'Increment' }).tap();
  });

  test('step 3 fails', async () => {
    throw new Error('wizard broke here');
  });

  test('step 4 never runs', async () => {});
});
`;
      const { outcome, project } = await runProject({ 'tests/serial.e2e.ts': file }, { appUrl: app.url });
      // 11-lifecycle.md: without a successful group attempt, each member uses
      // its status in the final group attempt.
      expect(resultByTitle(outcome, 'step 1 increments').status).toBe('passed');
      expect(resultByTitle(outcome, 'step 3 fails').status).toBe('failed');
      const step4 = resultByTitle(outcome, 'step 4 never runs');
      expect(step4.status).toBe('skipped');
      expect(step4.skip?.cause).toBe('serial-predecessor-failed');

      assertValidReport(outcome.report);
      const run = outcome.report['run'] as Record<string, unknown>;
      const groups = run['serialGroups'] as Record<string, unknown>[];
      expect(groups).toHaveLength(1);
      const group = groups[0]!;
      expect(group['status']).toBe('failed');
      const attempts = group['attempts'] as Record<string, unknown>[];
      expect(attempts).toHaveLength(1);
      const members = attempts[0]!['members'] as Record<string, unknown>[];
      expect(members.map((member) => member['status'])).toEqual([
        'passed',
        'passed',
        'failed',
        'skipped',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'reports config errors as exit 2 without executing tests',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/none.e2e.ts': `import { test } from 'e2e';\ntest('x', async () => {});\n` },
        {
          appUrl: app.url,
          config: { reporters: ['json', 'list'] as never },
          runOptions: { quiet: true },
        },
      );
      expect(outcome.exitCode).toBe(2);
      expect(outcome.status).toBe('error');
      project.cleanup();
    },
    120_000,
  );

  it(
    'fails with NO_TESTS unless --pass-with-no-tests',
    async () => {
      const empty = { 'tests/empty.txt': 'not a test' };
      const first = await runProject(empty, { appUrl: app.url });
      expect(first.outcome.exitCode).toBe(2);
      first.project.cleanup();

      const second = await runProject(empty, {
        appUrl: app.url,
        runOptions: { passWithNoTests: true },
      });
      expect(second.outcome.exitCode).toBe(0);
      second.project.cleanup();
    },
    120_000,
  );
});
