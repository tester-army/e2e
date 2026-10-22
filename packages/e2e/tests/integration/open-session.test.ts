/** Per-test sessions opened through the built runner's reusable host API. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import type { E2EHost, OpenHostOptions, StepProgress } from '../../src/runner.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const { openHost } = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const PROJECTS = new URL('../tmp-projects/', import.meta.url);

/** Where the config file finds the engines this test made. */
const ENGINES = '__e2eHostTestEngines';

describe('host.openSession', { timeout: 60_000 }, () => {
  let dir: string;
  let hosts: E2EHost[];

  /** A file config uses the same fake handles as a config value would. */
  const writeConfig = (targets: Record<string, FakeEngineHandle>): void => {
    (globalThis as Record<string, unknown>)[ENGINES] = Object.fromEntries(Object.entries(targets).map(([name, fake]) => [name, fake.engine]));
    const entries = Object.keys(targets).map(
      (name) => `{ name: ${JSON.stringify(name)}, platform: 'kiosk', engine: globalThis.${ENGINES}[${JSON.stringify(name)}], app: ${JSON.stringify(FAKE_APP)} }`,
    );
    writeFileSync(path.join(dir, 'e2e.config.ts'), `export default { targets: [${entries.join(', ')}] };\n`);
  };

  /** Retain hosts so an assertion failure cannot leave a published session behind. */
  async function open(options: OpenHostOptions = {}) {
    const host = await openHost({ cwd: dir, env: {}, ...options });
    hosts.push(host);
    return host;
  }

  beforeEach(() => {
    mkdirSync(PROJECTS, { recursive: true });
    dir = mkdtempSync(path.join(PROJECTS.pathname, 'open-session-'));
    hosts = [];
  });

  afterEach(async () => {
    for (const host of hosts) await host.close();
    delete (globalThis as Record<string, unknown>)[ENGINES];
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the target with its fixtures, streams steps, and closes each owner once', async () => {
    const cleanup: string[] = [];
    const fake = createFakeEngine({ fixtures: true, artifacts: true, onDispose: (context) => {
      cleanup.push(context.reuseSignal === undefined ? 'final' : 'reusable');
    } });
    writeConfig({ kiosk: fake });
    const progress: StepProgress[] = [];
    const host = await open();
    const session = await host.openSession({ name: 'home screen', onStep: (step) => progress.push(step) });
    expect(session.target).toBe('kiosk');
    expect(session.fixtures.platform).toBe('kiosk');
    expect(session.fixtures.gadget).toBeDefined();
    expect(session.runId).toBe(host.runId);
    expect(path.isAbsolute(session.artifactsDir)).toBe(true);
    expect(path.isAbsolute(session.tracePath)).toBe(true);

    const shotPath = await session.fixtures.app.screenshot('home');
    expect(shotPath).toBe(path.join(session.artifactsDir, 'screenshots', 'fake.png'));
    expect(existsSync(shotPath)).toBe(true);
    expect(progress.filter((step) => step.phase === 'start')).toHaveLength(1);
    expect(progress.filter((step) => step.phase === 'end')).toHaveLength(1);
    const shot = session.steps().find((step) => step.api === 'app.screenshot');
    expect(shot?.status).toBe('passed');
    expect(shot?.artifacts.length).toBe(1);

    expect(await session.close()).toEqual([]);
    expect(await session.close()).toEqual([]);
    expect(readFileSync(session.tracePath, 'utf8')).toContain('app.screenshot');
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, attemptsEnded: 1, disposes: 0 });
    expect(await host.close()).toEqual([]);
    expect(await host.close()).toEqual([]);
    expect(fake.stats().disposes).toBe(1);
    expect(cleanup).toEqual(['final']);
  });

  it('cancels a fixture call still running when the session closes', async () => {
    let performing!: () => void;
    const started = new Promise<void>((resolve) => (performing = resolve));
    const fake = createFakeEngine({
      perform: (_ref, _action, operation) =>
        new Promise<void>((_resolve, reject) => {
          performing();
          operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true });
        }),
    });
    writeConfig({ kiosk: fake });
    const host = await open();
    const session = await host.openSession({ name: 'cancel a click', timeout: 30_000 });
    const click = session.fixtures.screen.getByRole('button', 'Submit').click();
    const settled = click.then(() => 'resolved', () => 'rejected');
    await started;
    const failures = await session.close();
    expect(await settled).toBe('rejected');
    expect(failures.map((failure) => failure.code)).toContain('STEP_NOT_AWAITED');
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 0 });
    await host.close();
    expect(fake.stats().disposes).toBe(1);
  });

  it('returns cleanup failures from close and throws them from session disposal', async () => {
    const fake = createFakeEngine({ onEndAttempt: () => Promise.reject(new Error('device stuck')) });
    writeConfig({ kiosk: fake });
    const host = await open();
    const session = await host.openSession({ name: 'cleanup failure' });
    const failures = await session.close();
    expect(failures.map((failure) => failure.message).join()).toContain('device stuck');
    expect(await session.close()).toEqual(failures);

    const disposed = (async () => {
      await using disposable = session;
      expect(disposable.target).toBe('kiosk');
    })();
    await expect(disposed).rejects.toBeInstanceOf(AggregateError);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
    await expect(host.openSession({ name: 'unsafe reuse' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
  });

  it('opens a config value, resolved against cwd, with AsyncDisposable sessions', async () => {
    const fake = createFakeEngine();
    await using host = await open({
      config: { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app: FAKE_APP }] },
    });
    {
      await using session = await host.openSession({ name: 'config value' });
      expect(session.target).toBe('kiosk');
      expect(session.artifactsDir.startsWith(dir + path.sep)).toBe(true);
      expect(fake.inits[0]?.projectRoot).toBe(dir);
      expect(fake.stats().inits).toBe(1);
    }
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 0 });
  });

  it('needs a target when the config declares several, and opens the one named', async () => {
    const one = createFakeEngine();
    const two = createFakeEngine();
    writeConfig({ one, two });
    await expect(openHost({ cwd: dir, env: {} })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    await expect(openHost({ cwd: dir, env: {}, target: 'three' })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });

    await using host = await open({ target: 'two' });
    await using session = await host.openSession({ name: 'second target' });
    expect(session.target).toBe('two');
    expect(one.stats().inits).toBe(0);
    expect(two.stats().inits).toBe(1);
  });
});
