import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultId } from '../../src/internal/ids.ts';
import { createProject, listProject, resultByTitle, runExisting, runProject, type RunOutcome } from '../helpers/run-project.ts';
import type { FinishedRun } from '../../src/index.ts';

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
    'skips the running test from its body with test.skip(condition, reason), keeping the steps that ran',
    async () => {
      const file = `import { test } from 'e2e';

test('single organization', async ({ app }) => {
  await app.open();
  const organizations = 1;
  test.skip(organizations < 2, 'the demo tenant has a single organization');
  throw new Error('unreachable after a skip');
});

test('condition false runs on', async () => {
  test.skip(false, 'never');
});

test('bare skip', async () => {
  test.skip();
});

test.setup('sign in', { sessions: ['admin'] }, async ({ session }) => {
  test.skip(true, 'a setup may not skip');
  await session.save('admin');
});

test('consumer', { session: 'admin' }, async () => {});
`;
      const { outcome, project } = await runProject({ 'tests/runtime-skip.e2e.ts': file }, { appUrl: app.url });
      const conditional = resultByTitle(outcome, 'single organization');
      expect(conditional.status).toBe('skipped');
      expect(conditional.skip).toEqual({ cause: 'explicit', reason: 'the demo tenant has a single organization' });
      expect(conditional.attempts).toHaveLength(1);
      expect(conditional.attempts[0]?.status).toBe('skipped');
      expect(conditional.attempts[0]?.steps.map((step) => step.api)).toEqual(['app.open']);
      expect(resultByTitle(outcome, 'condition false runs on').status).toBe('passed');
      expect(resultByTitle(outcome, 'bare skip').skip).toEqual({ cause: 'explicit', reason: 'skipped' });
      const setup = resultByTitle(outcome, 'sign in');
      expect(setup.status).toBe('failed');
      expect(setup.attempts[0]?.error?.code).toBe('INVALID_ARGUMENT');
      expect(resultByTitle(outcome, 'consumer').skip?.cause).toBe('setup-failed');
      // The skipped tests do not fail the run; the setup does.
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    120_000,
  );

  it(
    'keeps the suite realm across a runtime skip and keeps a skipped serial member skipped',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

test.beforeAll(() => log('beforeAll:file'));
test.afterAll(() => log('afterAll:file'));

test('skips first', async () => {
  test.skip(true, 'not applicable here');
});

test('runs second', async () => {
  log('body:second');
});

test.describe('wizard', { serial: true }, () => {
  test('step 1 skips', async () => {
    test.skip('nothing to set up');
  });
  test('step 2 runs', async () => {
    log('body:step2');
  });
});
`;
      const logPath = path.join('/tmp', `e2e-skiprealm-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject({ 'tests/skip-realm.e2e.ts': file }, { appUrl: app.url });
      expect(resultByTitle(outcome, 'skips first').status).toBe('skipped');
      expect(resultByTitle(outcome, 'runs second').status).toBe('passed');
      const step1 = resultByTitle(outcome, 'step 1 skips');
      expect(step1.status).toBe('skipped');
      expect(step1.skip).toEqual({ cause: 'explicit', reason: 'nothing to set up' });
      expect(resultByTitle(outcome, 'step 2 runs').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
      // One realm for the ordinary tests, one for the group: the skip closed neither early.
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'beforeAll:file',
        'body:second',
        'afterAll:file',
        'beforeAll:file',
        'body:step2',
        'afterAll:file',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'rejects test.skip(condition) outside a test body at collection',
    async () => {
      const file = `import { test } from 'e2e';

test.skip(true, 'not here');
test('never registered', async () => {});
`;
      const { outcome, project } = await runProject({ 'tests/skip-outside.e2e.ts': file }, { appUrl: app.url });
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors.map((error) => error.code)).toEqual(['COLLECTION_ERROR']);
      expect(outcome.report.run.errors[0]?.message).toMatch(/must be called inside a test body/);
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
    'runs afterAll for a realm a failing test discards',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';

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
import { test } from 'e2e';

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
      const file = `import { test } from 'e2e';

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
import { test } from 'e2e';

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
      const consumerFile = `import { test } from '@e2edev/web';
import { expect } from 'e2e';

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
      // Without a successful group attempt, each member uses
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
    'writes junit.xml beside the report from the same document when the junit reporter is selected',
    async () => {
      const file = `import { test } from 'e2e';
test('passes', { tags: ['smoke'] }, async () => {});
test('fails', async () => {
  throw new Error('junit <sees> & "reports" this');
});
`;
      const { outcome, project } = await runProject(
        { 'tests/junit.e2e.ts': file },
        { appUrl: app.url, config: { reporters: ['junit'] } },
      );
      expect(outcome.exitCode).toBe(1);
      expect(outcome.report.run.results.map((result) => result.tags)).toEqual([['smoke'], []]);
      expect(outcome.reportPath).toBe(path.join(project.dir, '.e2e', 'report.json'));
      const xml = readFileSync(path.join(project.dir, '.e2e', 'junit.xml'), 'utf8');
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
      expect(xml).toContain(
        '<testsuite name="tests/junit.e2e.ts" tests="2" failures="1" errors="0" skipped="0"',
      );
      expect(xml).toContain('<testcase name="passes [web]" classname="tests/junit.e2e.ts"');
      expect(xml).toContain('<testcase name="fails [web]" classname="tests/junit.e2e.ts"');
      expect(xml).toContain('<failure message="junit &lt;sees&gt; &amp; &quot;reports&quot; this"');
      expect(readdirSync(path.join(project.dir, '.e2e')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'writes no junit.xml unless the reporter is selected',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/no-junit.e2e.ts': `import { test } from 'e2e';\ntest('x', async () => {});\n` },
        { appUrl: app.url },
      );
      expect(outcome.exitCode).toBe(0);
      expect(existsSync(path.join(project.dir, '.e2e', 'junit.xml'))).toBe(false);
      project.cleanup();
    },
    120_000,
  );

  it(
    'lists the selected pairs in report order without running anything',
    async () => {
      const files = {
        'tests/list.e2e.ts': `import { test } from 'e2e';
test('plain', async () => {});
test.describe('group', () => {
  test('nested', { tags: ['smoke'] }, async () => {});
  test('left out', { skip: 'not today' }, async () => {});
});
`,
        'tests/other.e2e.ts': `import { test } from 'e2e';
test('other', { tags: ['smoke'] }, async () => {});
`,
      };
      const { pairs, project } = await listProject(files, { appUrl: 'http://127.0.0.1:9' });
      expect(pairs.map((pair) => [pair.file, pair.titlePath.join(' > '), pair.target, pair.disposition])).toEqual([
        ['tests/list.e2e.ts', 'plain', 'web', 'run'],
        ['tests/list.e2e.ts', 'group > nested', 'web', 'run'],
        ['tests/list.e2e.ts', 'group > left out', 'web', 'skip'],
        ['tests/other.e2e.ts', 'other', 'web', 'run'],
      ]);
      expect(pairs.map((pair) => pair.tags)).toEqual([[], ['smoke'], [], ['smoke']]);
      expect(pairs[2]?.skipReason).toBe('not today');
      expect(existsSync(path.join(project.dir, '.e2e'))).toBe(false);
      project.cleanup();

      // A config glob spelled with a leading `./` selects the same files.
      const dotted = await listProject(files, {
        appUrl: 'http://127.0.0.1:9',
        config: { tests: './tests/**/*.e2e.ts' },
      });
      expect(dotted.pairs.map((pair) => pair.title)).toEqual(['plain', 'nested', 'left out', 'other']);
      dotted.project.cleanup();

      const tagged = await listProject(files, {
        appUrl: 'http://127.0.0.1:9',
        listOptions: { tags: ['smoke'], files: ['tests/other.e2e.ts'] },
      });
      expect(tagged.pairs.map((pair) => pair.title)).toEqual(['other']);
      tagged.project.cleanup();

      const grepped = await listProject(files, {
        appUrl: 'http://127.0.0.1:9',
        listOptions: { grepInvert: [/^group/], excludeTags: ['smoke'] },
      });
      expect(grepped.pairs.map((pair) => pair.title)).toEqual(['plain']);
      grepped.project.cleanup();


      await expect(listProject({ 'tests/empty.txt': '' }, { appUrl: 'http://127.0.0.1:9' })).rejects.toMatchObject({
        code: 'NO_TESTS',
      });
    },
    120_000,
  );

  it(
    'runs every selected test n times under --repeat-each, each run its own result, and --last-failed names a test any repeat of which failed',
    async () => {
      const files = {
        'tests/repeat.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
const marker = new URL('./ran-once', import.meta.url);
test('steady', async () => {});
test('breaks the second time', async () => {
  if (existsSync(marker)) throw new Error('second run breaks');
  writeFileSync(marker, '');
});
`,
      };
      const { outcome, project } = await runProject(files, { appUrl: app.url, runOptions: { repeatEach: 3, retries: 0 } });
      expect(outcome.exitCode).toBe(1);
      const results = outcome.report.run.results.toSorted((a, b) => a.declarationIndex - b.declarationIndex || a.repeat - b.repeat);
      expect(results.map((result) => [result.titlePath[0], result.repeat, result.status])).toEqual([
        ['steady', 0, 'passed'],
        ['steady', 1, 'passed'],
        ['steady', 2, 'passed'],
        ['breaks the second time', 0, 'passed'],
        ['breaks the second time', 1, 'failed'],
        ['breaks the second time', 2, 'failed'],
      ]);
      expect(new Set(results.map((result) => result.id)).size).toBe(6);
      expect(results[0]!.id).toBe(resultId(results[0]!.testId, 'web', 'default'));
      const paths = results[4]!.attempts[0]!.artifacts.flatMap((artifact) => (artifact.path === undefined ? [] : [artifact.path]));
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((artifactPath) => artifactPath.includes('/repeat-1/'))).toBe(true);
      expect(outcome.report.run.summary).toMatchObject({ selected: 6, executed: 6, passed: 4, failed: 2 });

      // Only the breaking test failed, on its later repeats; the rerun names it once and runs it once,
      // and hands its reporters the report it selected from.
      let handed: FinishedRun | undefined;
      const rerun = await runExisting(project, {
        appUrl: app.url,
        runOptions: { lastFailed: true },
        config: {
          reporters: [
            {
              name: 'capture',
              onRunFinished: async (run) => {
                handed = run;
              },
            },
          ],
        },
      });
      expect(rerun.results.filter((result) => result.selected).map((result) => result.test.title)).toEqual(['breaks the second time']);
      expect(handed?.lastRun?.run.id).toBe(outcome.report.run.id);

      const invalid = await runExisting(project, { appUrl: app.url, runOptions: { repeatEach: 0 } });
      expect(invalid.exitCode).toBe(2);
      expect(invalid.report.run.errors.map((error) => error.message)).toEqual(['repeatEach must be a positive safe integer, got 0']);
      project.cleanup();
    },
    120_000,
  );

  it(
    'stops at --max-failures: the rest is skipped with the reason and the exit code is the failures\' own',
    async () => {
      const files = {
        'tests/limit.e2e.ts': `import { test } from 'e2e';
test('first fails', async () => { throw new Error('one'); });
test('second fails', async () => { throw new Error('two'); });
test('never runs', async () => {});
test('never runs either', async () => { throw new Error('three'); });
`,
      };
      const events: string[] = [];
      const { outcome, project } = await runProject(files, {
        appUrl: app.url,
        runOptions: { maxFailures: 2, onEvent: (event) => { if (event.type === 'run-stopped') events.push(`${event.failures}/${event.limit}`); } },
      });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.report.run.status).toBe('failed');
      expect(events).toEqual(['2/2']);
      const byDeclaration = outcome.results.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
      expect(byDeclaration.map((result) => [result.test.title, result.status, result.skip?.cause])).toEqual([
        ['first fails', 'failed', undefined],
        ['second fails', 'failed', undefined],
        ['never runs', 'skipped', 'failure-limit'],
        ['never runs either', 'skipped', 'failure-limit'],
      ]);
      expect(byDeclaration[2]!.skip?.reason).toBe('run stopped after 2 failures (--max-failures 2)');

      // The SDK path is bounded like the flag: a count below one is a configuration error, not a run that stops at once.
      const invalid = await runExisting(project, { appUrl: app.url, runOptions: { maxFailures: 0 } });
      expect(invalid.exitCode).toBe(2);
      expect(invalid.report.run.errors.map((error) => [error.code, error.message])).toEqual([
        ['INVALID_CONFIG', 'maxFailures must be a positive safe integer, got 0'],
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'stops at --max-failures inside a serial group and reports each member once',
    async () => {
      const files = {
        'tests/serial-limit.e2e.ts': `import { test } from 'e2e';
test.describe('wizard', { serial: true }, () => {
  test('step 1 fails', async () => { throw new Error('one'); });
  test('step 2', async () => {});
  test('step 3', async () => {});
});
test('after the group', async () => {});
test('after the group too', async () => {});
`,
      };
      let planned = 0;
      const { outcome, project } = await runProject(files, {
        appUrl: app.url,
        runOptions: { maxFailures: 1, onEvent: (event) => { if (event.type === 'plan') planned = event.total; } },
      });
      expect(outcome.exitCode).toBe(1);
      expect(planned).toBe(5);
      const byDeclaration = outcome.results.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
      expect(byDeclaration.map((result) => [result.test.title, result.status, result.skip?.cause])).toEqual([
        ['step 1 fails', 'failed', undefined],
        ['step 2', 'skipped', 'serial-predecessor-failed'],
        ['step 3', 'skipped', 'serial-predecessor-failed'],
        ['after the group', 'skipped', 'failure-limit'],
        ['after the group too', 'skipped', 'failure-limit'],
      ]);
      expect(outcome.report.run.summary.discovered).toBe(planned);
      expect(new Set(outcome.report.run.results.map((result) => result.id)).size).toBe(planned);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    120_000,
  );

  it(
    'an interrupt reports every test it never started, and --last-failed runs them next',
    async () => {
      const sleeping = `import { test } from 'e2e';
test('sleeps until interrupted', async () => {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`;
      const project = createProject({
        'tests/first.e2e.ts': sleeping,
        'tests/second.e2e.ts': `import { test } from 'e2e';
test('never started', async () => {});
test('never started either', async () => {});
`,
      });
      const controller = new AbortController();
      let planned = 0;
      const interrupted = await runExisting(project, {
        appUrl: app.url,
        runOptions: {
          interruptSignal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'plan') planned = event.total;
            if (event.type === 'test-started') controller.abort();
          },
        },
      });
      expect(interrupted.exitCode).toBe(130);
      expect(interrupted.status).toBe('interrupted');
      expect(planned).toBe(3);
      expect(interrupted.report.run.summary.discovered).toBe(planned);
      for (const title of ['never started', 'never started either']) {
        const result = resultByTitle(interrupted, title);
        expect(result.status).toBe('skipped');
        expect(result.skip).toEqual({ cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' });
      }
      assertValidReport(interrupted.report);

      // The rerun reads the report the interrupt wrote; the body that slept passes at once now.
      writeFileSync(path.join(project.dir, 'tests', 'first.e2e.ts'), sleeping.replace('setTimeout(resolve, 60_000)', 'setTimeout(resolve, 0)'));
      const rerun = await runExisting(project, { appUrl: app.url, runOptions: { lastFailed: true } });
      expect(rerun.exitCode).toBe(0);
      const byFile = rerun.results.toSorted((a, b) => (a.test.file === b.test.file ? a.test.declarationIndex - b.test.declarationIndex : a.test.file < b.test.file ? -1 : 1));
      expect(byFile.map((result) => [result.test.title, result.selected, result.status])).toEqual([
        ['sleeps until interrupted', true, 'passed'],
        ['never started', true, 'passed'],
        ['never started either', true, 'passed'],
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'a run-level model failure reports every queued test it never started, and --last-failed runs them next',
    async () => {
      const needsModel = `import { test } from 'e2e';
test('needs the model', async ({ app, agent }) => {
  await app.open();
  await agent.assert('anything');
});
`;
      const project = createProject({
        'tests/first.e2e.ts': needsModel,
        'tests/second.e2e.ts': `import { test } from 'e2e';
test('queued behind it', async () => {});
test('queued behind it too', async () => {});
`,
      });
      const aborted = await runExisting(project, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', workers: 1 },
      });
      expect(aborted.exitCode).toBe(2);
      expect(aborted.report.run.errors.map((error) => error.code)).toEqual(['MODEL_UNAVAILABLE']);
      expect(aborted.report.run.summary.discovered).toBe(3);
      expect(['MODEL_UNAVAILABLE', 'INTERRUPTED']).toContain(resultByTitle(aborted, 'needs the model').attempts.at(-1)!.error!.code);
      for (const title of ['queued behind it', 'queued behind it too']) {
        const result = resultByTitle(aborted, title);
        expect(result.status).toBe('skipped');
        expect(result.attempts).toHaveLength(0);
        expect(result.skip).toEqual({ cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' });
      }
      assertValidReport(aborted.report);

      // The rerun reads the report the abort wrote; without the agent fixture the first test passes too.
      writeFileSync(
        path.join(project.dir, 'tests', 'first.e2e.ts'),
        `import { test } from 'e2e';
test('needs the model', async ({ app }) => {
  await app.open();
});
`,
      );
      const rerun = await runExisting(project, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', workers: 1 },
        runOptions: { lastFailed: true },
      });
      expect(rerun.exitCode).toBe(0);
      const byFile = rerun.results.toSorted((a, b) => (a.test.file === b.test.file ? a.test.declarationIndex - b.test.declarationIndex : a.test.file < b.test.file ? -1 : 1));
      expect(byFile.map((result) => [result.test.title, result.selected, result.status])).toEqual([
        ['needs the model', true, 'passed'],
        ['queued behind it', true, 'passed'],
        ['queued behind it too', true, 'passed'],
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'runs only what the previous run did not pass under --last-failed, and needs a report to read',
    async () => {
      const files = {
        'tests/rerun.e2e.ts': `import { test } from 'e2e';
test('passes', async () => {});
test('fails', async () => {
  throw new Error('still broken');
});
test('also passes', async () => {});
`,
      };
      const fresh = await runProject(files, { appUrl: app.url, runOptions: { lastFailed: true } });
      expect(fresh.outcome.exitCode).toBe(2);
      expect(fresh.outcome.report.run.errors.map((error) => [error.code, error.phase])).toEqual([['NO_LAST_RUN', 'collection']]);
      expect(fresh.outcome.report.run.errors[0]!.message).toContain(path.join(fresh.project.dir, '.e2e', 'report.json'));

      const first = await runExisting(fresh.project, { appUrl: app.url });
      expect(first.exitCode).toBe(1);
      const second = await runExisting(fresh.project, { appUrl: app.url, runOptions: { lastFailed: true } });
      expect(second.exitCode).toBe(1);
      const byTitle = second.results.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
      expect(byTitle.map((result) => [result.test.title, result.selected, result.status])).toEqual([
        ['passes', false, 'skipped'],
        ['fails', true, 'failed'],
        ['also passes', false, 'skipped'],
      ]);
      expect(byTitle[0]!.skip?.reason).toBe('did not fail in the last run');
      fresh.project.cleanup();
    },
    120_000,
  );

  it(
    '--last-failed runs a failed hook\'s scope again until the hook passes',
    async () => {
      const hooks = (teardown: string) => `import { test } from 'e2e';
test.describe('teardown', () => {
  test.afterAll(() => {
    ${teardown}
  });
  test('passes in the scope', async () => {});
});
test('passes outside it', async () => {});
`;
      const brokenBody = `import { test } from 'e2e';
test('fails', async () => {
  throw new Error('still broken');
});
`;
      const project = createProject({
        'tests/hooks.e2e.ts': hooks(`throw new Error('teardown broke');`),
        'tests/body.e2e.ts': brokenBody,
      });
      const selection = (outcome: RunOutcome) =>
        outcome.results
          .toSorted((a, b) => (a.test.file === b.test.file ? a.test.declarationIndex - b.test.declarationIndex : a.test.file < b.test.file ? -1 : 1))
          .map((result) => [result.test.title, result.selected, result.status]);
      const hookErrors = (outcome: RunOutcome) =>
        outcome.report.run.errors.map((error) => [error.code, error.phase, error.scopeId, error.file, error.targetId]);

      const first = await runExisting(project, { appUrl: app.url });
      expect(first.exitCode).toBe(1);
      expect(hookErrors(first)).toEqual([['HOOK_FAILED', 'afterAll', 'teardown', 'tests/hooks.e2e.ts', 'web']]);
      assertValidReport(first.report);

      // The body is fixed, the hook is not: the scope runs again and still fails the run.
      writeFileSync(path.join(project.dir, 'tests', 'body.e2e.ts'), brokenBody.replace(`throw new Error('still broken');`, ''));
      const second = await runExisting(project, { appUrl: app.url, runOptions: { lastFailed: true } });
      expect(second.exitCode).toBe(1);
      expect(selection(second)).toEqual([
        ['fails', true, 'passed'],
        ['passes in the scope', true, 'passed'],
        ['passes outside it', false, 'skipped'],
      ]);
      expect(hookErrors(second)).toEqual([['HOOK_FAILED', 'afterAll', 'teardown', 'tests/hooks.e2e.ts', 'web']]);

      // The hook is fixed: its scope runs once more and the error is gone, not carried.
      writeFileSync(path.join(project.dir, 'tests', 'hooks.e2e.ts'), hooks(''));
      const third = await runExisting(project, { appUrl: app.url, runOptions: { lastFailed: true } });
      expect(third.exitCode).toBe(0);
      expect(selection(third)).toEqual([
        ['fails', false, 'skipped'],
        ['passes in the scope', true, 'passed'],
        ['passes outside it', false, 'skipped'],
      ]);
      expect(third.report.run.errors).toEqual([]);
      const fourth = await runExisting(project, { appUrl: app.url, runOptions: { lastFailed: true } });
      expect(fourth.exitCode).toBe(2);
      expect(fourth.report.run.errors.map((error) => error.code)).toEqual(['NO_TESTS']);
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
    'selects positional directories and globs, and names the ones that matched nothing',
    async () => {
      const file = (title: string) => `import { test } from 'e2e';\ntest('${title}', async () => {});\n`;
      const files = {
        'tests/top.e2e.ts': file('top'),
        'tests/agent/one.e2e.ts': file('agent one'),
        'tests/agent/nested/two.e2e.ts': file('agent two'),
        'tests/other/three.e2e.ts': file('other three'),
      };
      // Every discovered file is collected; the ones no positional named are
      // report-only unselected results, as tag-filtered tests are.
      const titles = (outcome: RunOutcome) =>
        outcome.results.filter((result) => result.selected).map((result) => result.test.title).toSorted();
      const unselected = (outcome: RunOutcome) =>
        outcome.results.filter((result) => !result.selected).map((result) => result.test.title).toSorted();

      const directory = await runProject(files, { appUrl: app.url, runOptions: { files: ['tests/agent'] } });
      expect(directory.outcome.exitCode).toBe(0);
      expect(titles(directory.outcome)).toEqual(['agent one', 'agent two']);
      expect(unselected(directory.outcome)).toEqual(['other three', 'top']);
      directory.project.cleanup();

      const glob = await runProject(files, {
        appUrl: app.url,
        runOptions: { files: ['tests/*/*.e2e.ts', 'tests/top.e2e.ts'] },
      });
      expect(glob.outcome.exitCode).toBe(0);
      expect(titles(glob.outcome)).toEqual(['agent one', 'other three', 'top']);
      glob.project.cleanup();

      const missing = await runProject(files, {
        appUrl: app.url,
        runOptions: { files: ['tests/agnet', 'tests/*.spec.ts'] },
      });
      expect(missing.outcome.exitCode).toBe(2);
      expect(missing.outcome.report.run.errors.map((error) => [error.code, error.message])).toEqual([
        [
          'NO_TESTS',
          expect.stringMatching(
            /^no test file matched tests\/agnet, tests\/\*\.spec\.ts; the config globs discovered tests\/.* and \d+ more; pass --pass-with-no-tests to allow this$/,
          ),
        ],
      ]);
      missing.project.cleanup();
    },
    120_000,
  );
  it(
    'closes a scope when its last test finishes and keeps same-titled siblings apart',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';

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
import { test } from 'e2e';

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
      const file = `import { test } from 'e2e';

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
import { test } from 'e2e';

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
import { test } from 'e2e';

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
      const file = `import { test, expect } from 'e2e';

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
import { test, expect } from 'e2e';

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
import { test } from 'e2e';

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
      const file = `import { test } from 'e2e';

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
