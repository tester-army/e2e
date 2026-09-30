import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('test.extend fixtures', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it(
    'sets fixtures up in order, hands them to hooks and the body, and tears them down last first',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test as base } from 'e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

const test = base
  .extend<{ first: string }>({
    first: async ({ platform }, use) => {
      log('setup:first:' + platform);
      await use('one');
      log('teardown:first');
    },
  })
  .extend<{ second: string }>({
    // A later definition reads an earlier one.
    second: async ({ first }, use) => {
      log('setup:second:' + first);
      await use(first + '-two');
      log('teardown:second');
    },
  });

// Hooks read the fixtures of the test they wrap, so these stay in a group
// whose tests all carry the chain.
test.describe('chain', () => {
  test.beforeEach(({ second }) => log('beforeEach:' + second));
  test.afterEach(({ first }) => log('afterEach:' + first));

  test('sees the values', async ({ first, second, app }) => {
    await app.open();
    log('body:' + first + ':' + second);
  });

  test('fails in the body', async ({ second }) => {
    log('body:failing:' + second);
    throw new Error('body boom');
  });
});

const leaky = base.extend<{ leaky: string }>({
  leaky: async (_fixtures, use) => {
    await use('leaky');
    throw new Error('teardown boom');
  },
});
leaky('teardown fails after a pass', async ({ leaky }) => {
  log('body:' + leaky);
});

const silent = base.extend<{ silent: string }>({
  silent: async () => {
    log('setup:silent');
  },
});
silent('never calls use', async ({ silent }) => {
  log('unreachable:' + silent);
});

const clash = base.extend<{ browser: string }>({
  browser: async (_fixtures, use) => {
    await use('not the browser');
  },
});
clash('redefines an engine fixture', async ({ browser }) => {
  log('unreachable:' + String(browser));
});
`;
      const logPath = path.join('/tmp', `e2e-extend-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/extend.e2e.ts': file }, { appUrl: app.url });
      assertValidReport(outcome.report);

      const passes = resultByTitle(outcome, 'sees the values');
      expect(passes.status).toBe('passed');

      const fails = resultByTitle(outcome, 'fails in the body');
      expect(fails.status).toBe('failed');
      expect(fails.attempts[0]!.error?.phase).toBe('body');
      expect(fails.attempts[0]!.error?.message).toContain('body boom');
      expect(fails.attempts[0]!.secondaryErrors).toEqual([]);

      const leaky = resultByTitle(outcome, 'teardown fails after a pass');
      expect(leaky.status).toBe('failed');
      expect(leaky.attempts[0]!.error?.phase).toBe('afterEach');
      expect(leaky.attempts[0]!.error?.message).toContain('teardown boom');

      const silent = resultByTitle(outcome, 'never calls use');
      expect(silent.status).toBe('failed');
      expect(silent.attempts[0]!.error?.phase).toBe('beforeEach');
      expect(silent.attempts[0]!.error?.code).toBe('TEST_SETUP_FAILED');
      expect(silent.attempts[0]!.error?.message).toContain('fixture "silent" returned without calling use()');

      const clash = resultByTitle(outcome, 'redefines an engine fixture');
      expect(clash.status).toBe('failed');
      expect(clash.attempts[0]!.error?.phase).toBe('beforeEach');
      expect(clash.attempts[0]!.error?.code).toBe('TEST_SETUP_FAILED');
      expect(clash.attempts[0]!.error?.message).toContain('fixture "browser" is contributed by engine web');

      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'setup:first:web',
        'setup:second:one',
        'beforeEach:one-two',
        'body:one:one-two',
        'afterEach:one',
        'teardown:second',
        'teardown:first',
        'setup:first:web',
        'setup:second:one',
        'beforeEach:one-two',
        'body:failing:one-two',
        'afterEach:one',
        'teardown:second',
        'teardown:first',
        'body:leaky',
        'setup:silent',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'releases a fixture that reaches use() after the attempt timed out under its setup',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test as base } from 'e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

const test = base.extend<{ slow: string }>({
  slow: async (_fixtures, use) => {
    log('setup:slow');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await use('slow');
    log('teardown:slow');
  },
});

test('times out in setup', { timeout: 1000 }, async ({ slow }) => {
  log('unreachable:' + slow);
});
`;
      const logPath = path.join('/tmp', `e2e-extend-late-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/late.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'times out in setup');
      expect(result.status).toBe('timed-out');
      expect(result.attempts[0]!.error?.phase).toBe('beforeEach');
      // The abandoned setup is still running in this process; its `use` is
      // released on arrival, so the teardown lands after the run finished.
      await vi.waitFor(
        () => expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['setup:slow', 'teardown:slow']),
        { timeout: 10_000, interval: 100 },
      );
      project.cleanup();
    },
    120_000,
  );
});
