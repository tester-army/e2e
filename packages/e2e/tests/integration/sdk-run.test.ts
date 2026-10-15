import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, webTarget, workerFakeConfigSource, type FixtureProject } from '../helpers/run-project.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const { run, openHost } = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const sdkModule = new URL('../../dist/index.js', import.meta.url).href;
const { credentials } = (await import(sdkModule)) as typeof import('../../src/index.ts');

describe('public run', () => {
  let app: FixtureApp;
  const projects: FixtureProject[] = [];

  beforeAll(async () => { app = await startFixtureApp(); });
  afterAll(async () => { await app.close(); });
  afterEach(() => { for (const fixture of projects.splice(0)) fixture.cleanup(); });

  /** Creates a fixture project retained until the test ends. */
  function project(files: Record<string, string>): FixtureProject {
    const created = createProject(files);
    projects.push(created);
    return created;
  }

  it('executes selected browser tests from a runtime config and streams their results', async () => {
    const fixture = project({
      'tests/home.e2e.ts': `import { test, expect } from 'e2e';
test('home', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { name: 'Home' })).toBeVisible();
});`,
      'tests/other.e2e.ts': `import { test } from 'e2e'; test('not selected', async () => { throw new Error('must not run'); });`,
    });
    const events: RunEvent[] = [];
    const outcome = await run({
      cwd: fixture.dir,
      config: { targets: [webTarget('web', app.url)] },
      files: ['tests/home.e2e.ts'],
      onEvent: (event) => { events.push(event); },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');
    expect(outcome.report.run.summary).toMatchObject({ executed: 1, passed: 1, failed: 0 });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run-started', 'test-started', 'test-finished', 'run-finished']));
    expect(events.at(-1)).toMatchObject({ type: 'run-finished', exitCode: 0, status: 'passed' });
    expect(outcome.reportPath).toBe(path.join(fixture.dir, '.e2e', 'report.json'));
    expect(JSON.parse(readFileSync(outcome.reportPath!, 'utf8'))).toEqual(outcome.report);
    expect(outcome).not.toHaveProperty('config');
    expect(outcome).not.toHaveProperty('results');
    assertValidReport(outcome.report);
  });

  it('returns failed assertions and completes engine cleanup without exiting the caller', async () => {
    const fake = createFakeEngine();
    const fixture = project({ 'tests/failure.e2e.ts': `import { test, expect } from 'e2e'; test('fails', async () => { expect(1).toBe(2); });` });
    const outcome = await run({ cwd: fixture.dir, config: { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }] } });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.status).toBe('failed');
    expect(outcome.report.run.summary.failed).toBe(1);
    expect(outcome.report.run.results[0]?.attempts[0]?.cleanup).toBe('complete');
    expect(fake.events).toContain('dispose');
    assertValidReport(outcome.report);
  });

  it('cancels a browser run, executes teardown, and permits the next run', async () => {
    const fixture = project({ 'tests/cancel.e2e.ts': `import { writeFileSync } from 'node:fs';
import { test, expect } from 'e2e';
test.afterEach(() => writeFileSync(new URL('../cleanup.txt', import.meta.url), 'complete'));
test('waits', async ({ app, screen }) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { name: 'never appears' })).toBeVisible();
});` });
    const controller = new AbortController();
    const outcome = await run({
      cwd: fixture.dir,
      config: { targets: [webTarget('web', app.url)] },
      interruptSignal: controller.signal,
      onEvent: (event) => { if (event.type === 'step' && event.progress.api === 'app.open' && event.progress.phase === 'end') controller.abort(); },
    });
    expect(outcome.exitCode).toBe(130);
    expect(outcome.status).toBe('interrupted');
    expect(readFileSync(path.join(fixture.dir, 'cleanup.txt'), 'utf8')).toBe('complete');
    expect(outcome.report.run.results[0]?.attempts[0]?.cleanup).toBe('complete');
    const next = project({ 'tests/next.e2e.ts': `import { test } from 'e2e'; test('next', async () => {});` });
    expect((await run({ cwd: next.dir, config: { targets: [webTarget('web', app.url)] } })).exitCode).toBe(0);
  });

  it('loads an explicit file config and discovers it when config is omitted', async () => {
    const fixture = project({
      'e2e.config.ts': workerFakeConfigSource(2),
      'tests/a.e2e.ts': `import { test } from 'e2e'; test('a', async () => {});`,
      'tests/b.e2e.ts': `import { test } from 'e2e'; test('b', async () => {});`,
    });
    for (const config of ['e2e.config.ts', undefined]) {
      const outcome = await run({ cwd: fixture.dir, ...(config === undefined ? {} : { config }) });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.report.run.summary.passed).toBe(2);
    }
  });

  it('executes the targets selected by the runtime config', async () => {
    const first = createFakeEngine();
    const second = createFakeEngine();
    const fixture = project({ 'tests/target.e2e.ts': `import { test } from 'e2e'; test('target', async () => {});` });
    const outcome = await run({
      cwd: fixture.dir,
      config: { targets: [first, second].map((fake, index) => ({ name: `target-${index}`, platform: 'test', engine: fake.engine, app: FAKE_APP })) },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.run.summary.passed).toBe(2);
    expect(first.events).toContain('dispose');
    expect(second.events).toContain('dispose');
  });

  it('returns configuration failures in the report and releases the run reservation', async () => {
    const fixture = project({ 'tests/empty.e2e.ts': `import { test } from 'e2e'; test('empty', async () => {});` });
    const fake = createFakeEngine();
    const config = { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }] };
    const invalid = await run({ cwd: fixture.dir, config: { ...config, timeout: 0 } });
    expect(invalid.status).toBe('error');
    expect(invalid.exitCode).toBe(2);
    expect(invalid.report.run.errors[0]?.code).toBe('INVALID_CONFIG');
    expect((await run({ cwd: fixture.dir, config })).exitCode).toBe(0);
  });

  it('rejects overlapping calls before they can alter an active run', async () => {
    const fake = createFakeEngine();
    const fixture = project({ 'tests/one.e2e.ts': `import { test } from 'e2e'; test('one', async () => {});` });
    const config = { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }] };
    let overlap: Promise<unknown> | undefined;
    const outcome = await run({
      cwd: fixture.dir, config,
      onEvent: (event) => {
        if (event.type === 'run-started') overlap = run({ cwd: fixture.dir, config }).catch((cause: unknown) => cause);
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(await overlap).toMatchObject({ code: 'RUNNER_BUSY', message: 'a public run is already in progress; await it before starting another' });
  });

  it('refuses a suite while a hosted session is live without changing its credentials', async () => {
    const fake = createFakeEngine();
    const fixture = project({ 'tests/one.e2e.ts': `import { test } from 'e2e'; test('one', async () => {});` });
    const targets = [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }];
    const host = await openHost({ cwd: fixture.dir, config: { targets, credentials: { admin: { username: 'account-A', password: 'password-A' } } } });
    try {
      const session = await host.openSession({ name: 'existing session' });
      expect(credentials.user('admin').username).toBe('account-A');
      await expect(run({ cwd: fixture.dir, config: { targets, credentials: { admin: { username: 'account-B', password: 'password-B' } } } })).rejects.toMatchObject({ code: 'RUNNER_BUSY' });
      expect(credentials.user('admin').username).toBe('account-A');
      await session.close();
      await expect(run({ cwd: fixture.dir, config: { targets } })).rejects.toMatchObject({ code: 'RUNNER_BUSY' });
    } finally {
      await host.close();
    }
    expect((await run({ cwd: fixture.dir, config: { targets } })).exitCode).toBe(0);
  });

  it('refuses host config loading inside a non-hosted suite attempt', async () => {
    const internalModule = new URL('../../dist/run/runner.js', import.meta.url).href;
    const { run: executeSuite } = (await import(internalModule)) as typeof import('../../src/run/runner.ts');
    const fake = createFakeEngine();
    const fixture = project({
      'tests/one.e2e.ts': `import { test, expect } from 'e2e';
import { defineEngine } from 'e2e/engine';
import { openHost } from 'e2e/runner';
test('refuses host', async () => {
  const engine = defineEngine({ name: 'other', version: '1', spiVersion: 1 });
  let code;
  try {
    const host = await openHost({ config: { targets: [{ name: 'other', platform: 'test', engine }] } });
    await host.close();
  } catch (cause) { code = cause.code; }
  expect(code).toBe('RUNNER_BUSY');
});`,
    });
    const rawConfig = { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }] };
    expect((await executeSuite({ cwd: fixture.dir, rawConfig, quiet: true })).exitCode).toBe(0);
  });

  it('refuses a host opening while a suite owns the process', async () => {
    const fake = createFakeEngine();
    const fixture = project({ 'tests/one.e2e.ts': `import { test } from 'e2e'; test('one', async () => {});` });
    const config = { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }] };
    let refusal: Promise<unknown> | undefined;
    const outcome = await run({
      cwd: fixture.dir, config,
      onEvent: (event) => {
        if (event.type === 'run-started') refusal = openHost({ cwd: fixture.dir, config }).then((host) => host.close(), (cause: unknown) => cause);
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(await refusal).toMatchObject({ code: 'RUNNER_BUSY' });
    const host = await openHost({ cwd: fixture.dir, config });
    await host.close();
  });

  it('shares its reservation with another module instance', async () => {
    const copyModule = new URL('../../dist/run/public-run.js?other-realm', import.meta.url).href;
    const { runSuite: otherRun } = (await import(copyModule)) as typeof import('../../src/run/public-run.ts');
    const fake = createFakeEngine();
    const fixture = project({ 'tests/one.e2e.ts': `import { test } from 'e2e'; test('one', async () => {});` });
    const config = { targets: [{ name: 'fake', platform: 'test', engine: fake.engine, app: FAKE_APP }] };
    let refusal: Promise<unknown> | undefined;
    const outcome = await run({
      cwd: fixture.dir, config,
      onEvent: (event) => {
        if (event.type === 'run-started') refusal = otherRun({ cwd: fixture.dir, config }).catch((cause: unknown) => cause);
      },
    });
    expect(outcome.exitCode).toBe(0);
    expect(await refusal).toMatchObject({ code: 'RUNNER_BUSY' });
  });
});
