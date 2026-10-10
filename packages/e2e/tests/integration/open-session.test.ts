/**
 * `openSession` from `e2e/runner` on the fake engine, from a config file as a
 * host's project has one, or a config value: a session opens the target's engine with its fixtures, streams step
 * progress, lists its steps, needs a target when the config declares
 * several, tears the engine down on close, once, cancels a fixture call
 * still running when it closes, and reports cleanup failures.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import type { StepProgress } from '../../src/runner.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const { openSession } = (await import(runnerModule)) as typeof import('../../src/runner.ts');

/** Where the config file below finds the fake engines this test made. */
const ENGINES = '__e2eHostTestEngines';

describe('openSession', { timeout: 60_000 }, () => {
  let dir: string;

  const writeConfig = (targets: Record<string, FakeEngineHandle>): void => {
    (globalThis as Record<string, unknown>)[ENGINES] = Object.fromEntries(Object.entries(targets).map(([name, fake]) => [name, fake.engine]));
    const entries = Object.keys(targets).map(
      (name) => `{ name: ${JSON.stringify(name)}, platform: 'kiosk', engine: globalThis.${ENGINES}[${JSON.stringify(name)}], app: ${JSON.stringify(FAKE_APP)} }`,
    );
    writeFileSync(path.join(dir, 'e2e.config.ts'), `export default { targets: [${entries.join(', ')}] };\n`);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-host-'));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[ENGINES];
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the target with its fixtures, streams steps, and closes once', async () => {
    const fake = createFakeEngine({ fixtures: true, artifacts: true });
    writeConfig({ kiosk: fake });
    const progress: StepProgress[] = [];
    const session = await openSession<{ gadget: unknown }>({ cwd: dir, env: {}, onStep: (step) => progress.push(step) });
    expect(session.target).toBe('kiosk');
    expect(session.fixtures.platform).toBe('kiosk');
    expect(session.fixtures.gadget).toBeDefined();
    expect(path.isAbsolute(session.artifactsDir)).toBe(true);

    await session.fixtures.app.screenshot('home');
    expect(progress.filter((step) => step.phase === 'start')).toHaveLength(1);
    expect(progress.filter((step) => step.phase === 'end')).toHaveLength(1);
    const shot = session.steps().find((step) => step.api === 'app.screenshot');
    expect(shot?.status).toBe('passed');
    expect(shot?.artifacts.length).toBe(1);

    expect(await session.close()).toEqual([]);
    expect(await session.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
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
    const session = await openSession({ cwd: dir, env: {}, timeout: 30_000 });
    const click = session.fixtures.screen.getByRole('button', 'Submit').click();
    const settled = click.then(
      () => 'resolved',
      () => 'rejected',
    );
    await started;
    await session.close();
    expect(await settled).toBe('rejected');
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
  });

  it('returns cleanup failures from close and throws them from disposal', async () => {
    const failing = () => createFakeEngine({ onEndAttempt: () => Promise.reject(new Error('device stuck')) });
    writeConfig({ kiosk: failing() });
    const session = await openSession({ cwd: dir, env: {} });
    const failures = await session.close();
    expect(failures.map((failure) => failure.message).join()).toContain('device stuck');

    writeConfig({ kiosk: failing() });
    const disposed = (async () => {
      await using disposable = await openSession({ cwd: dir, env: {} });
      expect(disposable.target).toBe('kiosk');
    })();
    await expect(disposed).rejects.toBeInstanceOf(AggregateError);
  });

  it('opens a config value, resolved against cwd', async () => {
    const fake = createFakeEngine();
    await using session = await openSession({
      cwd: dir,
      env: {},
      config: { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app: FAKE_APP }] },
    });
    expect(session.target).toBe('kiosk');
    expect(session.artifactsDir.startsWith(dir)).toBe(true);
    expect(fake.stats().inits).toBe(1);
  });

  it('needs a target when the config declares several, and opens the one named', async () => {
    const one = createFakeEngine();
    const two = createFakeEngine();
    writeConfig({ one, two });
    await expect(openSession({ cwd: dir, env: {} })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    await expect(openSession({ cwd: dir, env: {}, target: 'three' })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });

    await using session = await openSession({ cwd: dir, env: {}, target: 'two' });
    expect(session.target).toBe('two');
    expect(one.stats().inits).toBe(0);
    expect(two.stats().inits).toBe(1);
  });
});
