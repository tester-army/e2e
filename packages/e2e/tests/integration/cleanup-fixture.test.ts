import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

const LOG_PRELUDE = `import { appendFileSync } from 'node:fs';
const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');
`;

/** Points the fixture project's log at a fresh file and returns its lines after the run. */
function useLog(name: string): () => string[] {
  const logPath = path.join('/tmp', `e2e-cleanup-${name}-${Date.now()}.log`);
  process.env['HOOK_LOG'] = logPath;
  return () => readFileSync(logPath, 'utf8').trim().split('\n');
}

describe('cleanup fixture', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'runs callbacks newest first, after afterEach and before the fixture teardowns, with the fixtures alive',
    async () => {
      const file = `${LOG_PRELUDE}import { test as base, expect } from 'e2e';

const test = base.extend<{ api: { created: string[]; remove(id: string): void } }>({
  api: async ({ cleanup }, use) => {
    const created: string[] = [];
    const api = {
      created,
      remove(id: string) {
        log('delete:' + id);
        created.splice(created.indexOf(id), 1);
      },
    };
    await use(api);
    log('teardown:api:' + created.length);
  },
});

test.afterEach(({ api }) => log('afterEach:' + api.created.join(',')));

test('creates two records', async ({ app, screen, api, cleanup }) => {
  await app.open();
  for (const id of ['a', 'b']) {
    api.created.push(id);
    cleanup.add(() => api.remove(id));
  }
  cleanup.add(async () => {
    await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
    log('cleanup:screen');
  });
});
`;
      const lines = useLog('order');
      const { outcome, project } = await runProject({ 'tests/order.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'creates two records');
      expect(result.status).toBe('passed');
      expect(result.attempts[0]!.secondaryErrors).toEqual([]);
      expect(lines()).toEqual(['afterEach:a,b', 'cleanup:screen', 'delete:b', 'delete:a', 'teardown:api:0']);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'runs after a failure, a skip from the body, and a timeout, and adds from an afterEach hook',
    async () => {
      const file = `${LOG_PRELUDE}import { test } from 'e2e';

test.afterEach(({ cleanup }) => cleanup.add(() => log('cleanup:from-hook')));

test('fails', async ({ app, cleanup }) => {
  await app.open();
  cleanup.add(() => log('cleanup:fails'));
  throw new Error('body boom');
});

test('skips', async ({ app, cleanup }) => {
  await app.open();
  cleanup.add(() => log('cleanup:skips'));
  test.skip(true, 'nothing to do');
});

test('times out', { timeout: 1500 }, async ({ app, cleanup }) => {
  await app.open();
  cleanup.add(() => log('cleanup:times-out'));
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;
      const lines = useLog('verdicts');
      const { outcome, project } = await runProject(
        { 'tests/verdicts.e2e.ts': file },
        { appUrl: app.url, config: { workers: 1 } },
      );
      expect(resultByTitle(outcome, 'fails').status).toBe('failed');
      expect(resultByTitle(outcome, 'fails').attempts[0]!.error?.message).toContain('body boom');
      expect(resultByTitle(outcome, 'skips').status).toBe('skipped');
      expect(resultByTitle(outcome, 'times out').status).toBe('timed-out');
      for (const title of ['fails', 'skips', 'times out']) {
        expect(resultByTitle(outcome, title).attempts[0]!.secondaryErrors).toEqual([]);
      }
      expect(lines()).toEqual([
        'cleanup:from-hook',
        'cleanup:fails',
        'cleanup:from-hook',
        'cleanup:skips',
        'cleanup:from-hook',
        'cleanup:times-out',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'records a throwing or overrunning callback as a secondary error, keeps the verdict, and runs the rest',
    async () => {
      const file = `${LOG_PRELUDE}import { test } from 'e2e';

test('passes', async ({ app, cleanup }) => {
  await app.open();
  cleanup.add(() => log('cleanup:last'));
  cleanup.add(async () => {
    log('cleanup:slow:start');
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    log('cleanup:slow:done');
  });
  cleanup.add(() => {
    throw new Error('cleanup boom');
  });
});
`;
      const lines = useLog('errors');
      const { outcome, project } = await runProject(
        { 'tests/errors.e2e.ts': file },
        { appUrl: app.url, config: { cleanupTimeout: 1000 } },
      );
      const result = resultByTitle(outcome, 'passes');
      expect(result.status).toBe('passed');
      expect(result.attempts[0]!.error).toBeUndefined();
      expect(result.attempts[0]!.secondaryErrors.map((error) => [error.phase, error.code, error.message])).toEqual([
        ['cleanup', 'ERROR', 'cleanup boom'],
        ['cleanup', 'TEST_TIMEOUT', 'cleanup callback timed out'],
      ]);
      expect(lines()).toEqual(['cleanup:slow:start', 'cleanup:last']);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );
});
