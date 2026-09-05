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
import { test } from '@e2edev/e2e';

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

  // Declared after the test: still applies, after this scope's earlier hooks.
  test.beforeEach(() => log('beforeEach:group-late'));
  test.afterEach(() => log('afterEach:group-late'));
});

// File-scope hooks declared below the group still wrap the group's own hooks.
test.beforeEach(() => log('beforeEach:file-late'));
test.afterEach(() => log('afterEach:file-late'));
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
        'beforeEach:file-late',
        'beforeEach:group',
        'beforeEach:group-late',
        'body:web',
        'afterEach:group-late',
        'afterEach:group',
        'afterEach:file-late',
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
      const file = `import { test } from '@e2edev/e2e';

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
    'runs afterAll for a realm a failing test discards',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeAll(() => log('beforeAll'));
test.afterAll(() => log('afterAll'));

test('first fails', async () => {
  log('body:first');
  throw new Error('boom');
});

test('second passes', async ({ app }) => {
  log('body:second');
  await app.open();
});
`;
      const logPath = path.join('/tmp', `e2e-discard-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/discard.e2e.ts': file }, { appUrl: app.url });
      expect(resultByTitle(outcome, 'first fails').status).toBe('failed');
      expect(resultByTitle(outcome, 'second passes').status).toBe('passed');
      // The failed realm is discarded but its afterAll still runs; the fresh
      // realm for the second test reruns beforeAll and tears down at the end.
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'beforeAll',
        'body:first',
        'afterAll',
        'beforeAll',
        'body:second',
        'afterAll',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'runs suite hooks for serial groups and setup tests',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeAll(() => log('beforeAll:file'));
test.afterAll(() => log('afterAll:file'));

test.setup('seed', { sessions: ['seeded'] }, async ({ app, session }) => {
  log('body:setup');
  await app.open('/storage');
  await session.save('seeded');
});

test.describe('wizard', { serial: true }, () => {
  test.beforeAll(() => log('beforeAll:wizard'));
  test.afterAll(() => log('afterAll:wizard'));

  test('step 1', async ({ app }) => {
    log('body:step1');
    await app.open();
  });

  test('step 2', async () => {
    log('body:step2');
  });
});

test('consumer', { session: 'seeded' }, async ({ app }) => {
  log('body:consumer');
  await app.open();
});
`;
      const logPath = path.join('/tmp', `e2e-suitehooks-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/hooks.e2e.ts': file }, { appUrl: app.url });
      expect(resultByTitle(outcome, 'seed').status).toBe('passed');
      expect(resultByTitle(outcome, 'step 1').status).toBe('passed');
      expect(resultByTitle(outcome, 'step 2').status).toBe('passed');
      expect(resultByTitle(outcome, 'consumer').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      // The setup unit, the serial group, and the ordinary test each own a
      // realm: file-scope hooks wrap each, and the group scope enters once
      // for both members.
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'beforeAll:file',
        'body:setup',
        'afterAll:file',
        'beforeAll:file',
        'beforeAll:wizard',
        'body:step1',
        'body:step2',
        'afterAll:wizard',
        'afterAll:file',
        'beforeAll:file',
        'body:consumer',
        'afterAll:file',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'skips every serial member behind a failing beforeAll and fails the group',
    async () => {
      const file = `import { test } from '@e2edev/e2e';

test.describe('wizard', { serial: true }, () => {
  test.beforeAll(() => {
    throw new Error('wizard setup exploded');
  });
  test('step 1', async () => {});
  test('step 2', async () => {});
});
`;
      const { outcome, project } = await runProject({ 'tests/serialhook.e2e.ts': file }, { appUrl: app.url });
      for (const title of ['step 1', 'step 2']) {
        const result = resultByTitle(outcome, title);
        expect(result.status).toBe('skipped');
        expect(result.skip?.cause).toBe('hook-failed');
      }
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('failed');
      expect(group.attempts).toHaveLength(1);
      expect(group.attempts[0]!.error?.code).toBe('HOOK_FAILED');
      expect(outcome.exitCode).not.toBe(0);
      project.cleanup();
    },
    120_000,
  );

  it(
    'keeps the failed attempts when a retry hits a beforeAll failure',
    async () => {
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

test.beforeAll(() => {
  if (existsSync(process.env.RETRY_MARKER!)) throw new Error('second realm cannot boot');
});

test('fails then cannot retry', { retries: 1 }, async ({ app }) => {
  await app.open();
  writeFileSync(process.env.RETRY_MARKER!, 'attempted');
  throw new Error('first attempt fails');
});
`;
      const marker = path.join('/tmp', `e2e-retryhook-${Date.now()}`);
      process.env['RETRY_MARKER'] = marker;
      const { outcome, project } = await runProject({ 'tests/retryhook.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'fails then cannot retry');
      expect(result.status).toBe('failed');
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]!.error?.message).toContain('first attempt fails');
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );

  it(
    'retries failed attempts in fresh realms and reports flaky',
    async () => {
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

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
      const file = `import { test } from '@e2edev/e2e';

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
      const setupFile = `import { test, expect } from '@e2edev/e2e';

test.setup('seed storage', { sessions: ['seeded'] }, async ({ app, screen, session }) => {
  await app.open('/storage');
  await screen.getByRole('button', { name: 'Save marker' }).tap();
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  await session.save('seeded');
});
`;
      const consumerFile = `import { test } from '@e2edev/playwright';
import { expect } from '@e2edev/e2e';

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
      const file = `import { test } from '@e2edev/e2e';

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
      const file = `import { test, expect } from '@e2edev/e2e';

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
        { 'tests/none.e2e.ts': `import { test } from '@e2edev/e2e';\ntest('x', async () => {});\n` },
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
    'writes junit.xml beside the report from the same document when the junit reporter is selected',
    async () => {
      const file = `import { test } from '@e2edev/e2e';
test('passes', async () => {});
test('fails', async () => {
  throw new Error('junit <sees> & "reports" this');
});
`;
      const { outcome, project } = await runProject(
        { 'tests/junit.e2e.ts': file },
        { appUrl: app.url, config: { reporters: ['junit'] } },
      );
      expect(outcome.exitCode).toBe(1);
      expect(outcome.reportPath).toBe(path.join(project.dir, '.e2e', 'report.json'));
      expect(outcome.junitPath).toBe(path.join(project.dir, '.e2e', 'junit.xml'));
      const xml = readFileSync(outcome.junitPath!, 'utf8');
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
      expect(xml).toContain(
        '<testsuite name="tests/junit.e2e.ts" tests="2" failures="1" errors="0" skipped="0"',
      );
      expect(xml).toContain('<testcase name="passes [web]" classname="tests/junit.e2e.ts"');
      expect(xml).toContain('<testcase name="fails [web]" classname="tests/junit.e2e.ts"');
      expect(xml).toContain('<failure message="junit &lt;sees&gt; &amp; &quot;reports&quot; this"');
      expect(readdirSync(path.join(project.dir, '.e2e')).filter((name) => name.includes('.tmp-'))).toEqual([]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'writes no junit.xml unless the reporter is selected',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/no-junit.e2e.ts': `import { test } from '@e2edev/e2e';\ntest('x', async () => {});\n` },
        { appUrl: app.url },
      );
      expect(outcome.junitPath).toBeUndefined();
      expect(existsSync(path.join(project.dir, '.e2e', 'junit.xml'))).toBe(false);
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
  it(
    'closes a scope when its last test finishes and keeps same-titled siblings apart',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeAll(() => log('beforeAll:file'));
test.afterAll(() => log('afterAll:file'));

test.describe('A', () => {
  test.beforeAll(() => log('beforeAll:A'));
  test.afterAll(() => log('afterAll:A'));
  test.beforeEach(() => log('beforeEach:A'));
  test('a1', async () => { log('body:a1'); });
  test('a2', async () => { log('body:a2'); });
});

test.describe('B', () => {
  test.beforeAll(() => log('beforeAll:B'));
  test.afterAll(() => log('afterAll:B'));
  test('b1', async () => { log('body:b1'); });
});

// A second group titled "A" is a scope of its own, not a re-entry of the first.
test.describe('A', () => {
  test.beforeAll(() => log('beforeAll:A2'));
  test.afterAll(() => log('afterAll:A2'));
  test.beforeEach(() => log('beforeEach:A2'));
  test('a3', async () => { log('body:a3'); });
});

test('top', async () => { log('body:top'); });
`;
      const logPath = path.join('/tmp', `e2e-scopes-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/scopes.e2e.ts': file }, { appUrl: app.url });
      expect(outcome.exitCode).toBe(0);
      // A's teardown runs once a2 is done, before B enters; the file scope
      // stays open across all of them and closes with the realm.
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'beforeAll:file',
        'beforeAll:A',
        'beforeEach:A',
        'body:a1',
        'beforeEach:A',
        'body:a2',
        'afterAll:A',
        'beforeAll:B',
        'body:b1',
        'afterAll:B',
        'beforeAll:A2',
        'beforeEach:A2',
        'body:a3',
        'afterAll:A2',
        'body:top',
        'afterAll:file',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'discards the realm after an afterAll failure so later tests start fresh',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeAll(() => log('beforeAll:file'));
test.afterAll(() => log('afterAll:file'));

test.describe('leaky', () => {
  test.afterAll(() => {
    log('afterAll:leaky');
    throw new Error('teardown exploded');
  });
  test('first', async () => { log('body:first'); });
});

test('later', async () => { log('body:later'); });
`;
      const logPath = path.join('/tmp', `e2e-afterall-fail-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/afterallfail.e2e.ts': file }, { appUrl: app.url });
      expect(resultByTitle(outcome, 'first').status).toBe('passed');
      expect(resultByTitle(outcome, 'later').status).toBe('passed');
      // The failed teardown ends that suite instance: the file scope closes
      // and the next test gets a fresh realm with its own beforeAll.
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'beforeAll:file',
        'body:first',
        'afterAll:leaky',
        'afterAll:file',
        'beforeAll:file',
        'body:later',
        'afterAll:file',
      ]);
      expect(outcome.report.run.errors.map((error) => [error.code, error.phase, error.scopeId])).toEqual([
        ['HOOK_FAILED', 'afterAll', 'leaky'],
      ]);
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );

  it(
    'ends a serial group attempt when a nested afterAll fails, skipping the rest without a retry',
    async () => {
      const file = `import { test } from '@e2edev/e2e';

test.describe('wizard', { serial: true, retries: 1 }, () => {
  test.describe('inner', () => {
    test.afterAll(() => {
      throw new Error('inner teardown exploded');
    });
    test('step 1', async () => {});
  });
  test('step 2', async () => {});
});
`;
      const { outcome, project } = await runProject({ 'tests/serialafterall.e2e.ts': file }, { appUrl: app.url });
      const skipped = resultByTitle(outcome, 'step 2');
      expect(skipped.status).toBe('skipped');
      expect(skipped.skip?.cause).toBe('hook-failed');
      const group = outcome.report.run.serialGroups[0]!;
      expect(group.status).toBe('failed');
      expect(group.attempts).toHaveLength(1);
      expect(group.attempts[0]!.error?.code).toBe('HOOK_FAILED');
      expect(group.attempts[0]!.error?.phase).toBe('afterAll');
      expect(outcome.exitCode).not.toBe(0);
      project.cleanup();
    },
    120_000,
  );

  it(
    'runs member hooks for every serial member and closes nested scopes as members finish',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeEach(() => log('beforeEach:file'));
test.afterEach(() => log('afterEach:file'));

test.describe('wizard', { serial: true }, () => {
  test.beforeEach(() => log('beforeEach:wizard'));
  test.afterEach(() => log('afterEach:wizard'));

  test.describe('inner', () => {
    test.beforeAll(() => log('beforeAll:inner'));
    test.afterAll(() => log('afterAll:inner'));
    test('step 1', async () => { log('body:step1'); });
  });

  test('step 2', async () => { log('body:step2'); });
});
`;
      const logPath = path.join('/tmp', `e2e-serialhooks-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/serialhooks.e2e.ts': file }, { appUrl: app.url });
      expect(outcome.exitCode).toBe(0);
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'beforeAll:inner',
        'beforeEach:file',
        'beforeEach:wizard',
        'body:step1',
        'afterEach:wizard',
        'afterEach:file',
        'afterAll:inner',
        'beforeEach:file',
        'beforeEach:wizard',
        'body:step2',
        'afterEach:wizard',
        'afterEach:file',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'fails in phase beforeEach without running the body, and still runs afterEach',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeEach(() => {
  log('beforeEach');
  throw new Error('setup boom');
});
test.afterEach(() => log('afterEach'));

test('never runs', async () => { log('body'); });
`;
      const logPath = path.join('/tmp', `e2e-beforeeach-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/beforeeach.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'never runs');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.phase).toBe('beforeEach');
      expect(result.attempts[0]!.error?.message).toContain('setup boom');
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['beforeEach', 'afterEach']);
      project.cleanup();
    },
    120_000,
  );

  it(
    'makes an afterEach failure primary after a pass and secondary after a body failure',
    async () => {
      const file = `import { test, expect } from '@e2edev/e2e';

test.afterEach(async ({ screen }) => {
  // Fixtures keep working in teardown after the body failed.
  await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
  throw new Error('teardown boom');
});

test('passes', async ({ app }) => { await app.open(); });
test('fails', async ({ app }) => { await app.open(); throw new Error('body boom'); });
`;
      const { outcome, project } = await runProject({ 'tests/aftereach.e2e.ts': file }, { appUrl: app.url });
      const passes = resultByTitle(outcome, 'passes');
      expect(passes.status).toBe('failed');
      expect(passes.attempts[0]!.error?.phase).toBe('afterEach');
      expect(passes.attempts[0]!.error?.message).toContain('teardown boom');
      const fails = resultByTitle(outcome, 'fails');
      expect(fails.attempts[0]!.error?.phase).toBe('body');
      expect(fails.attempts[0]!.error?.message).toContain('body boom');
      expect(fails.attempts[0]!.secondaryErrors.map((error) => [error.phase, error.message])).toEqual([
        ['afterEach', 'teardown boom'],
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'gives afterEach a working fixture budget after the body timed out',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test, expect } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.afterEach(async ({ screen }) => {
  log('afterEach:start');
  await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
  log('afterEach:done');
});

test('sleeps forever', { timeout: 1500 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;
      const logPath = path.join('/tmp', `e2e-timeout-cleanup-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/timeoutcleanup.e2e.ts': file }, { appUrl: app.url });
      const result = resultByTitle(outcome, 'sleeps forever');
      expect(result.status).toBe('timed-out');
      expect(result.attempts[0]!.error?.phase).toBe('body');
      expect(result.attempts[0]!.secondaryErrors).toEqual([]);
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['afterEach:start', 'afterEach:done']);
      project.cleanup();
    },
    120_000,
  );

  it(
    'cancels an afterEach hook that overruns cleanupTimeout and still runs the next one',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from '@e2edev/e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

// Declared first, so it runs last: teardown is reverse declaration order.
test.afterEach(() => log('afterEach:next'));

test.afterEach(async () => {
  log('afterEach:start');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  log('afterEach:done');
});

test('passes', async ({ app }) => { await app.open(); });
`;
      const logPath = path.join('/tmp', `e2e-cleanup-overrun-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject(
        { 'tests/overrun.e2e.ts': file },
        { appUrl: app.url, config: { cleanupTimeout: 1000 } },
      );
      const result = resultByTitle(outcome, 'passes');
      expect(result.status).toBe('timed-out');
      expect(result.attempts[0]!.error?.phase).toBe('afterEach');
      expect(result.attempts[0]!.error?.message).toContain('afterEach hook timed out');
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['afterEach:start', 'afterEach:next']);
      project.cleanup();
    },
    120_000,
  );

  it(
    'times out suite hooks against their budgets and names the scope in run errors',
    async () => {
      const file = `import { test } from '@e2edev/e2e';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.afterAll(() => sleep(5000));

test.describe('slow scope', () => {
  test.beforeAll(() => sleep(5000));
  test('unreachable', async () => {});
});
`;
      const { outcome, project } = await runProject(
        { 'tests/hooktimeouts.e2e.ts': file },
        { appUrl: app.url, config: { timeout: 1000, cleanupTimeout: 1000 } },
      );
      const skipped = resultByTitle(outcome, 'unreachable');
      expect(skipped.status).toBe('skipped');
      expect(skipped.skip?.cause).toBe('hook-failed');
      expect(outcome.report.run.errors.map((error) => [error.phase, error.scopeId, error.code])).toEqual([
        ['beforeAll', 'slow scope', 'HOOK_FAILED'],
        ['afterAll', 'file', 'HOOK_FAILED'],
      ]);
      assertValidReport(outcome.report);
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );
});
