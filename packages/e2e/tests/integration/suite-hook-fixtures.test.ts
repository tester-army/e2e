/**
 * `beforeAll` and `afterAll` drive the target: `app`, `screen`, and the
 * engine's fixtures over a hook attempt that starts at the hooks' first
 * step. On the fake engine for the lifecycle (what starts and on whose
 * time, what a failure becomes, what a serial group shares), and through the real web engine for
 * the one thing only a browser has: a download a hook keeps is redacted.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, type FakeEngineBehavior } from '../helpers/fake-engine.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

/** Runs one test file on a fake engine this process holds, so what the engine was asked is readable afterwards. */
async function runOnFake(source: string, behavior: FakeEngineBehavior = {}, config: Partial<E2EConfig> = {}) {
  const fake = createFakeEngine({ fixtures: true, ...behavior });
  const { outcome, project } = await runProject(
    { 'tests/hooks.e2e.ts': source },
    { config: { targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, app: FAKE_APP }], ...config } },
  );
  assertValidReport(outcome.report);
  return { fake, outcome, project };
}

/** The hook attempt directories a run left under its results. */
function hookDirs(project: FixtureProject): string[] {
  const results = path.join(project.dir, '.e2e', 'results');
  return existsSync(results) ? readdirSync(results).filter((name) => /^hooks-(beforeAll|afterAll)-/.test(name)) : [];
}

describe('suite hook fixtures', () => {
  const projects: FixtureProject[] = [];

  afterAll(() => {
    for (const project of projects) project.cleanup();
  });

  it('starts a hook attempt at the hooks\' first step, and none for hooks that take no step', async () => {
    const { fake, outcome, project } = await runOnFake(`import { test } from 'e2e';

test.describe('seeded', () => {
  test.beforeAll(({ platform }) => {
    if (platform !== 'fake') throw new Error('wrong platform');
  });
  test.afterAll(() => {});
  test('seeded test', async () => {});
});

test.describe('driven', () => {
  test.beforeAll(async ({ app, gadget }) => {
    await app.open('/');
    await gadget.poke('setup');
  });
  test.afterAll(async ({ gadget }) => {
    await gadget.poke('teardown');
  });
  test('driven test', async ({ gadget }) => {
    await gadget.poke('body');
  });
});
`);
    projects.push(project);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    // One attempt for each test, and one for each phase of the scope whose hooks took a step.
    expect(fake.events.filter((event) => event !== 'init' && event !== 'dispose')).toEqual([
      'startAttempt:0', 'endAttempt:0',
      'startAttempt:1', 'endAttempt:1',
      'startAttempt:2', 'endAttempt:2',
      'startAttempt:3', 'endAttempt:3',
    ]);
    expect(fake.fixtureCalls).toEqual(['poke:setup', 'poke:body', 'poke:teardown']);
    // The hook's navigation ran on the hook attempt, not on the test's.
    expect(fake.callsOf(fake.attempts[1]!.attemptId, 'session')).toEqual([expect.objectContaining({ method: 'open' })]);
    expect(fake.callsOf(fake.attempts[2]!.attemptId, 'session')).toEqual([]);
    expect(hookDirs(project)).toEqual([]);
  });

  it('fails the scope with HOOK_FAILED for a per-test fixture, a soft assertion, a step left running, and test.skip()', async () => {
    const { outcome, project } = await runOnFake(`import { expect, test } from 'e2e';

test.describe('agent', () => {
  test.beforeAll(({ agent }) => void agent);
  test('needs agent', async () => {});
});

test.describe('soft', () => {
  test.beforeAll(() => {
    expect.soft(1).toBe(2);
  });
  test('needs soft', async () => {});
});

test.describe('unawaited', () => {
  test.beforeAll(({ gadget }) => {
    void gadget.slow();
  });
  test('needs unawaited', async () => {});
});

test.describe('skip', () => {
  test.beforeAll(() => {
    test.skip(true, 'not here');
  });
  test('needs skip', async () => {});
});
`);
    projects.push(project);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.run.errors.map((error) => [error.scopeId, error.code, error.category])).toEqual([
      ['agent', 'HOOK_FAILED', 'test'],
      ['soft', 'HOOK_FAILED', 'test'],
      ['unawaited', 'HOOK_FAILED', 'test'],
      ['skip', 'HOOK_FAILED', 'test'],
    ]);
    const [agent, soft, unawaited, skip] = outcome.report.run.errors.map((error) => error.message);
    expect(agent).toContain('beforeAll has no "agent" fixture');
    expect(soft).toMatch(/expected.*2/is);
    expect(unawaited).toContain('the beforeAll hook returned before gadget.slow');
    expect(skip).toContain('must be called inside a test body');
    for (const title of ['needs agent', 'needs soft', 'needs unawaited', 'needs skip']) {
      expect(resultByTitle(outcome, title)).toMatchObject({ status: 'skipped', skip: { cause: 'hook-failed' } });
    }
  });

  it('reports a hook attempt the engine would not start as an infrastructure failure, and runs the next scope', async () => {
    const { outcome, project } = await runOnFake(
      `import { test } from 'e2e';

test.describe('no device', () => {
  test.beforeAll(async ({ gadget }) => {
    await gadget.poke('setup');
  });
  test('never runs', async () => {});
});

test('still runs', async () => {});
`,
      {
        onStartAttempt: (_context, attemptIndex) => {
          if (attemptIndex === 0) throw new Error('the simulator went away');
        },
      },
    );
    projects.push(project);
    expect(outcome.report.run.errors).toEqual([
      expect.objectContaining({ code: 'HOOK_FAILED', category: 'infrastructure', phase: 'beforeAll', scopeId: 'no device' }),
    ]);
    expect(outcome.report.run.errors[0]!.message).toContain('the simulator went away');
    expect(outcome.exitCode).toBe(3);
    expect(resultByTitle(outcome, 'never runs')).toMatchObject({ status: 'skipped', skip: { cause: 'hook-failed' } });
    expect(resultByTitle(outcome, 'still runs').status).toBe('passed');
  });

  it('does not charge a slow hook attempt start to the hook, and gives the hook its budget once the attempt is up', async () => {
    const { fake, outcome, project } = await runOnFake(
      `import { test } from 'e2e';

test.describe('cold', () => {
  test.beforeAll(async ({ app, gadget }) => {
    await gadget.poke('setup');
    await app.open('/');
  });
  test('after a cold start', async () => {});
});
`,
      {
        onStartAttempt: async (_context, attemptIndex) => {
          if (attemptIndex === 0) await new Promise((resolve) => setTimeout(resolve, 600));
        },
      },
      { timeout: 400 },
    );
    projects.push(project);
    expect(outcome.report.run.errors).toEqual([]);
    expect(resultByTitle(outcome, 'after a cold start').status).toBe('passed');
    // The start outlasted the hook's 400 ms, and the hook's first session call still has most of them.
    expect(fake.operations.find((operation) => operation.method.startsWith('session.open'))?.timeoutMs).toBeGreaterThan(300);
  });

  it('starts nothing for a hook that overran and reaches a fixture after its hook attempt closed', async () => {
    const { fake, outcome, project } = await runOnFake(
      `import { test } from 'e2e';

test.describe('late', () => {
  test.afterAll(async ({ gadget }) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await gadget.poke('late');
  });
  test('before the hook', async () => {});
});

test('outlives the late call', async () => {
  await new Promise((resolve) => setTimeout(resolve, 700));
});
`,
      {},
      { cleanupTimeout: 100 },
    );
    projects.push(project);
    expect(outcome.report.run.errors.map((error) => [error.scopeId, error.code])).toEqual([['late', 'HOOK_FAILED']]);
    expect(outcome.report.run.errors[0]!.message).toContain('afterAll hook timed out');
    expect(resultByTitle(outcome, 'outlives the late call').status).toBe('passed');
    // The two tests' attempts, and none for the hook.
    expect(fake.stats()).toMatchObject({ attemptsStarted: 2, attemptsEnded: 2 });
    expect(fake.fixtureCalls).toEqual([]);
  });

  it('serves a serial group\'s hooks from the group\'s session and files what they attach under the group', async () => {
    const { fake, outcome, project } = await runOnFake(`import { test } from 'e2e';

test.describe('flow', { serial: true }, () => {
  test.beforeAll(async ({ gadget }) => {
    await gadget.dropFile();
  });
  test.afterAll(async ({ gadget }) => {
    await gadget.poke('teardown');
  });
  test('first', async ({ gadget }) => {
    await gadget.poke('first');
  });
  test('second', async ({ gadget }) => {
    await gadget.poke('second');
  });
});
`);
    projects.push(project);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1 });
    expect(fake.fixtureCalls).toEqual(['poke:first', 'poke:second', 'poke:teardown']);
    const [group] = outcome.report.run.serialGroups;
    expect(group!.attempts[0]!.artifacts).toContainEqual(expect.objectContaining({ kind: 'log', path: expect.stringMatching(/gadget\/log\.txt$/) }));
    expect(hookDirs(project)).toEqual([]);
  });
});

describe('suite hook downloads', () => {
  const SECRET = 'hook-secret-Qx7#"&=2718';
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('rewrites a text download a hook keeps after a secret fill, on a hook attempt and on a serial group\'s session', async () => {
    const hook = `async ({ app, screen, browser }) => {
    await app.open('/exports');
    await screen.getByLabel('Export key').fill(credentials.user('member').password);
    await browser.waitForDownload(() => screen.getByRole('link', { name: 'Download export' }).tap());
  }`;
    const run = await runProject(
      {
        'tests/downloads.e2e.ts': `import { test } from '@e2e-dev/web';
import { credentials } from 'e2e';

test.describe('ordinary', () => {
  test.beforeAll(${hook});
  test('after an ordinary hook', async () => {});
});

test.describe('serial', { serial: true }, () => {
  test.beforeAll(${hook});
  test('after a serial hook', async () => {});
});
`,
      },
      { appUrl: app.url, config: { credentials: { member: { username: 'ada', password: SECRET } } } },
    );
    project = run.project;
    const { outcome } = run;
    expect(outcome.status, JSON.stringify(outcome.report.run.errors, null, 2)).toBe('passed');
    const results = path.join(project.dir, '.e2e', 'results');
    const [hookDir] = hookDirs(project);
    const kept = readdirSync(path.join(results, hookDir!, 'downloads')).map((name) => path.join(results, hookDir!, 'downloads', name));
    const shared = outcome.report.run.serialGroups[0]!.attempts[0]!.artifacts.find((artifact) => artifact.kind === 'download')!;
    expect(shared).toMatchObject({ redaction: 'complete' });
    for (const file of [...kept, path.join(results, shared.path!)]) {
      expect(readFileSync(file, 'utf8')).toBe('id,key\n1,<secret:member.password>\n');
    }
  }, 120_000);
});
