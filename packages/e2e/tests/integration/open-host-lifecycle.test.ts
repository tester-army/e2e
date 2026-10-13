/** Hosted attempts reuse one prepared worker: lifecycle, reservation, overlap, and close ordering. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepProgress } from '../../src/runner.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { ENGINES, gate, hostHarness, openHost, provisioned, sdkExpect } from '../helpers/open-host.ts';

describe('openHost: lifecycle', { timeout: 60_000 }, () => {
  const { host, config, heldGate, dir } = hostHarness();

  it('prepares and initializes once, with fresh fixtures, steps, ids and artifacts per session', async () => {
    const fake = createFakeEngine({ fixtures: true, artifacts: true });
    const pool = provisioned(fake);
    const notices: string[] = [];
    const opened = await host(pool.engine, {
      headed: true,
      env: { OVERRIDE: 'host', FROM_HOST: 'host' },
      onNotice: (target, message) => notices.push(`${target}: ${message}`),
    });
    expect(opened.target).toBe('kiosk');
    expect(pool.prepares).toHaveLength(1);
    expect(pool.prepares[0]).toMatchObject({ runId: opened.runId, slots: 1, projectRoot: dir(), headed: true });
    expect(fake.inits[0]).toMatchObject({
      runId: opened.runId,
      projectRoot: dir(),
      headed: true,
      env: { FROM_PREPARE: 'prepared', OVERRIDE: 'host', FROM_HOST: 'host' },
    });

    const progress: StepProgress[] = [];
    const first = await opened.openSession({ name: 'first checkout', timeout: 5_000, onStep: (step) => progress.push(step) });
    expect(first.runId).toBe(opened.runId);
    expect(first.target).toBe(opened.target);
    expect(first.fixtures.platform).toBe('kiosk');
    expect(first.fixtures.gadget.describe()).toContain('kiosk');
    expect(first.steps()).toEqual([]);
    await first.fixtures.gadget.poke('first');
    await first.fixtures.app.screenshot('first home');
    expect(progress.filter((step) => step.phase === 'start')).toHaveLength(2);
    expect(progress.filter((step) => step.phase === 'end')).toHaveLength(2);
    expect(await first.close()).toEqual([]);
    expect(await first.close()).toEqual([]);
    expect(fake.stats().disposes).toBe(0);
    expect(pool.finishes).toHaveLength(0);

    const firstSteps = first.steps();
    const second = await opened.openSession({ name: 'second checkout', timeout: 10_000 });
    expect(second.runId).toBe(first.runId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.artifactsDir).not.toBe(first.artifactsDir);
    expect(second.tracePath).not.toBe(first.tracePath);
    expect(second.fixtures === first.fixtures).toBe(false);
    expect(second.steps()).toEqual([]);
    await second.fixtures.gadget.poke('second');
    expect(first.steps()).toEqual(firstSteps);
    expect(await second.close()).toEqual([]);
    expect(fake.callsOf(second.attemptId)).toEqual([]);
    expect(fake.fixtureCalls).toEqual(['poke:first', 'poke:second']);
    expect(fake.attempts.map((attempt) => attempt.artifactsDir)).toEqual([first.artifactsDir, second.artifactsDir]);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2, maxConcurrentAttempts: 1, disposes: 0 });
    for (const session of [first, second]) {
      expect(path.isAbsolute(session.artifactsDir)).toBe(true);
      expect(path.isAbsolute(session.tracePath)).toBe(true);
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace).toContain('gadget.poke');
      expect(trace).not.toContain('report.json');
    }
    expect(await opened.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(fake.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
    expect(pool.finishes[0]?.runId).toBe(opened.runId);
    expect(notices.join('\n')).toContain('pool ready');
    expect(notices.join('\n')).toContain('pool released');
  });

  it('isolates engine state and step ids between sequential sessions', async () => {
    const fake = createFakeEngine({ scene: () => [{ id: 'name', role: 'textbox', name: 'Name', value: 'initial' }] });
    const opened = await host(fake.engine);
    const first = await opened.openSession({ name: 'mutate a field' });
    await first.fixtures.app.open();
    await first.fixtures.screen.getByRole('textbox', 'Name').fill('first session');
    await sdkExpect(first.fixtures.screen.getByRole('textbox', 'Name')).toHaveValue('first session');
    expect(await first.close()).toEqual([]);
    const firstIds = new Set(first.steps().map((step) => step.id));
    const second = await opened.openSession({ name: 'fresh field' });
    await second.fixtures.app.open();
    await sdkExpect(second.fixtures.screen.getByRole('textbox', 'Name')).toHaveValue('initial');
    expect(second.steps().every((step) => !firstIds.has(step.id))).toBe(true);
    expect(fake.callsOf(second.attemptId, 'perform')).toEqual([]);
    expect(await second.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2 });
  });

  it('starts a declared app process once and keeps it alive between sessions until host close', async () => {
    const port = await freePort();
    const starts = path.join(dir(), 'starts.txt');
    const script = `
      require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n');
      require('node:http').createServer((_req, res) => res.end(String(process.pid)))
        .listen(${port}, '127.0.0.1');
    `;
    const app = {
      url: `http://127.0.0.1:${port}`,
      command: { executable: process.execPath, args: ['-e', script], startupTimeout: 15_000, shutdownTimeout: 2_000 },
    };
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app }] } });
    const pid = await (await fetch(app.url)).text();
    const first = await opened.openSession({ name: 'first request' });
    await first.close();
    expect(await (await fetch(app.url)).text()).toBe(pid);
    const second = await opened.openSession({ name: 'second request' });
    await second.close();
    expect(readFileSync(starts, 'utf8')).toBe('start\n');
    expect(await (await fetch(app.url)).text()).toBe(pid);
    await opened.close();
    await expect(fetch(app.url)).rejects.toThrow();
  });

  it('loads an explicit config path and selects only the named target', async () => {
    const one = createFakeEngine();
    const two = createFakeEngine();
    (globalThis as Record<string, unknown>)[ENGINES] = { one: one.engine, two: two.engine };
    writeFileSync(path.join(dir(), 'host.config.ts'), `export default { targets: [
      { name: 'one', platform: 'kiosk', engine: globalThis.${ENGINES}.one, app: ${JSON.stringify(FAKE_APP)} },
      { name: 'two', platform: 'kiosk', engine: globalThis.${ENGINES}.two, app: ${JSON.stringify(FAKE_APP)} }
    ] };\n`);
    await expect(openHost({ cwd: dir(), env: {}, config: 'host.config.ts' })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    await expect(openHost({ cwd: dir(), env: {}, config: 'host.config.ts', target: 'missing' })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });
    const opened = await host(two.engine, { config: 'host.config.ts', target: 'two' });
    await using session = await opened.openSession({ name: 'selected target' });
    expect(session.target).toBe('two');
    expect(one.stats().inits).toBe(0);
    expect(two.inits[0]?.projectRoot).toBe(dir());
    expect(two.stats().inits).toBe(1);
  });

  it('chooses the session agent without carrying its choice into the next session', async () => {
    const fake = createFakeEngine();
    const calls: string[] = [];
    const executor = (name: string) => ({ name, async runStep() {
      calls.push(name);
      return { status: 'passed' as const, summary: `done by ${name}` };
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      cache: 'off', agents: { default: { executor: executor('default') }, reviewer: { executor: executor('reviewer') } },
    }) });
    const first = await opened.openSession({ name: 'review', agent: 'reviewer' });
    await first.fixtures.agent.act('check the screen');
    expect(await first.close()).toEqual([]);
    const second = await opened.openSession({ name: 'default' });
    await second.fixtures.agent.act('check the screen');
    expect(await second.close()).toEqual([]);
    expect(calls).toEqual(['reviewer', 'default']);
  });

  it('reserves same-host and cross-host opening attempts before any engine start', async () => {
    const release = heldGate();
    const fake = createFakeEngine({ onStartAttempt: () => release.promise });
    const other = createFakeEngine();
    const opened = await host(fake.engine);
    const another = await host(other.engine);
    const opening = opened.openSession({ name: 'first proposal' });
    const same = opened.openSession({ name: 'same-host proposal' });
    const cross = another.openSession({ name: 'cross-host proposal' });
    expect(fake.stats().attemptsStarted).toBe(0);
    expect(other.stats().attemptsStarted).toBe(0);
    await Promise.all([
      expect(same).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' }),
      expect(cross).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' }),
    ]);
    expect(fake.stats().attemptsStarted).toBe(1);
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    const session = await opening;
    expect(await session.close()).toEqual([]);
    const next = await another.openSession({ name: 'rejected overlap did not poison the host' });
    expect(await next.close()).toEqual([]);
  });

  it.each(['opening', 'live', 'closing'] as const)('refuses same-host and cross-host overlap while a session is %s, before engine start', async (phase) => {
    const entered = gate();
    const released = heldGate();
    const fake = createFakeEngine({
      ...(phase === 'opening' ? { onStartAttempt: async () => { entered.resolve(); await released.promise; } } : {}),
      ...(phase === 'closing' ? { onEndAttempt: async () => { entered.resolve(); await released.promise; } } : {}),
    });
    const other = createFakeEngine();
    const opened = await host(fake.engine);
    const another = await host(other.engine);
    const opening = opened.openSession({ name: 'owner' });
    let closing: Promise<readonly unknown[]> | undefined;
    if (phase === 'opening') await entered.promise;
    else {
      const session = await opening;
      if (phase === 'closing') { closing = session.close(); await entered.promise; }
    }
    await expect(opened.openSession({ name: 'same-host overlap' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    await expect(another.openSession({ name: 'cross-host overlap' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(fake.stats().attemptsStarted).toBe(1);
    expect(other.stats().attemptsStarted).toBe(0);
    expect(other.stats().disposes).toBe(0);
    released.resolve();
    const session = await opening;
    await (closing ?? session.close());
    expect(fake.stats().maxConcurrentAttempts).toBe(1);
    const next = await another.openSession({ name: 'after release' });
    expect(await next.close()).toEqual([]);
    expect(other.stats().attemptsStarted).toBe(1);
  });

  it('keeps attempt publication through cleanup without leaking soft failures into another host', async () => {
    const ending = gate();
    const release = heldGate();
    const fake = createFakeEngine({ onEndAttempt: async () => { ending.resolve(); await release.promise; } });
    const other = createFakeEngine();
    const opened = await host(fake.engine);
    const another = await host(other.engine);
    const session = await opened.openSession({ name: 'soft owner' });
    sdkExpect.soft(1, 'first owner').toBe(2);
    const closing = session.close();
    await ending.promise;
    await expect(another.openSession({ name: 'during cleanup' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    expect((await closing).map((error) => error.code)).toContain('ASSERTION_FAILED');
    const next = await another.openSession({ name: 'new owner' });
    sdkExpect.soft('ok').toBe('ok');
    expect(await next.close()).toEqual([]);
  });

  it('keeps the host usable after a launch failure, as a run keeps its worker for the retry', async () => {
    let launches = 0;
    const failed = createFakeEngine({ onStartAttempt: () => { if (launches++ === 0) throw new Error('launch broke'); } });
    const pool = provisioned(failed);
    const opened = await host(pool.engine);
    await expect(opened.openSession({ name: 'broken start' })).rejects.toThrow('launch broke');
    expect(failed.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 0 });
    expect(pool.finishes).toHaveLength(0);
    const session = await opened.openSession({ name: 'next test on the same worker' });
    expect(failed.stats()).toMatchObject({ inits: 1, attemptsStarted: 2 });
    expect(await session.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(failed.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
  });

  it('keeps the host usable after a session signal cancels its launch', async () => {
    const controller = new AbortController();
    const starting = gate();
    const fake = createFakeEngine({ onStartAttempt: async (context, index) => {
      if (index !== 0) return;
      starting.resolve();
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    } });
    const opened = await host(fake.engine);
    const opening = opened.openSession({ name: 'cancelled launch', signal: controller.signal }).then(() => 'opened', (cause: unknown) => cause);
    await starting.promise;
    controller.abort();
    expect(await opening).toMatchObject({ code: 'CANCELLED' });
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 0 });
    const next = await opened.openSession({ name: 'after cancelled launch' });
    expect(await next.close()).toEqual([]);
  });

  it('releases a failed opening as soon as its launch has ended, so another host can open', async () => {
    const failed = createFakeEngine({ onStartAttempt: () => { throw new Error('start refused'); } });
    const opened = await host(failed.engine);
    const other = createFakeEngine();
    const another = await host(other.engine);
    await expect(opened.openSession({ name: 'failed owner' })).rejects.toThrow('start refused');
    const next = await another.openSession({ name: 'after failed launch elsewhere' });
    expect(other.stats().attemptsStarted).toBe(1);
    expect(await next.close()).toEqual([]);
  });

  it('host close cancels an opening session and waits for disposal and finish exactly once', async () => {
    const starting = gate();
    const fake = createFakeEngine({ onStartAttempt: (context) => new Promise<void>((_resolve, reject) => {
      starting.resolve();
      if (context.signal.aborted) reject(context.signal.reason);
      else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    }) });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const opening = opened.openSession({ name: 'cancel opening' }).then(() => 'opened', () => 'cancelled');
    await starting.promise;
    const [first, second] = await Promise.all([opened.close(), opened.close()]);
    expect(await opening).toBe('cancelled');
    expect(second).toEqual(first);
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, disposes: 1 });
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'after close' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    const nextHost = await host(createFakeEngine().engine);
    const next = await nextHost.openSession({ name: 'released publication' });
    expect(await next.close()).toEqual([]);
  });

  it('closes a host immediately after session publication without allowing the opening to escape', async () => {
    const fake = createFakeEngine();
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const opening = opened.openSession({ name: 'close before launch' }).then(() => 'opened', () => 'cancelled');
    expect(fake.stats().attemptsStarted).toBe(0);
    const closing = opened.close();
    expect(await opening).toBe('cancelled');
    await closing;
    expect(fake.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'closed owner' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    const replacement = await host(createFakeEngine().engine);
    const session = await replacement.openSession({ name: 'publication released after immediate close' });
    expect(await session.close()).toEqual([]);
  });

  it('host close cancels an active fixture call and waits for pending session cleanup', async () => {
    const performing = gate();
    const ending = gate();
    const release = heldGate();
    const fake = createFakeEngine({
      perform: (_ref, _action, operation) => new Promise<void>((_resolve, reject) => {
        performing.resolve();
        operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true });
      }),
      onEndAttempt: async () => { ending.resolve(); await release.promise; },
    });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const session = await opened.openSession({ name: 'active close' });
    const click = session.fixtures.screen.getByRole('button', 'Submit').click().then(() => 'passed', () => 'cancelled');
    await performing.promise;
    let closed = false;
    const closing = opened.close().then((errors) => { closed = true; return errors; });
    await ending.promise;
    expect(await click).toBe('cancelled');
    expect(closed).toBe(false);
    expect(fake.stats().disposes).toBe(0);
    expect(pool.finishes).toHaveLength(0);
    await expect(opened.openSession({ name: 'while host closes' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    release.resolve();
    const errors = await closing;
    expect(errors.map((error) => error.code)).toContain('STEP_NOT_AWAITED');
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(pool.finishes).toHaveLength(1);
    expect(await session.close()).toEqual(await session.close());
  });

  it('returns both soft assertion and cleanup failures, idempotently, then clears collection', async () => {
    const fake = createFakeEngine({ onEndAttempt: (index) => {
      if (index === 0) throw new Error('attempt cleanup broke');
    } });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'soft errors' });
    sdkExpect.soft(1, 'quantity').toBe(2);
    sdkExpect.soft('actual', 'label').toBe('expected');
    await sdkExpect.soft(session.fixtures.screen.getByRole('button', 'Submit')).toBeHidden({ timeout: 25 });
    await session.fixtures.app.open();
    const failures = await session.close();
    expect(failures.find((failure) => failure.code === 'ASSERTION_FAILED')?.message).toContain('3 soft assertions failed');
    expect(failures.map((failure) => failure.message).join('\n')).toContain('attempt cleanup broke');
    expect(await session.close()).toEqual(failures);
    expect(session.steps().at(-1)).toMatchObject({ api: 'app.open', status: 'passed' });
    await expect(opened.openSession({ name: 'unsafe reuse after failed endAttempt' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(fake.stats().disposes).toBe(1);
    const replacement = await host(createFakeEngine().engine);
    const clean = await replacement.openSession({ name: 'no inherited soft errors' });
    sdkExpect.soft(true).toBe(true);
    expect(await clean.close()).toEqual([]);
  });

  it('holds publication while disposing a worker whose endAttempt failed, then refuses reuse', async () => {
    const disposing = gate();
    const release = heldGate();
    const fake = createFakeEngine({
      onEndAttempt: () => { throw new Error('isolation did not close'); },
      onDispose: async () => { disposing.resolve(); await release.promise; },
    });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const other = createFakeEngine();
    const another = await host(other.engine);
    const session = await opened.openSession({ name: 'uncertain engine state' });
    const closing = session.close();
    await disposing.promise;
    await expect(another.openSession({ name: 'during failed teardown' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    expect((await closing).map((error) => error.message).join()).toContain('isolation did not close');
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'unsafe reuse' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    const replacement = await another.openSession({ name: 'after failed owner disposed' });
    expect(await replacement.close()).toEqual([]);
    await opened.close();
    expect(fake.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
  });

  it('AsyncDisposable reports session failures and host disposal failures as AggregateError', async () => {
    const fake = createFakeEngine({ onDispose: () => { throw new Error('worker disposal broke'); } });
    const opened = await host(fake.engine);
    const disposedSession = (async () => {
      await using session = await opened.openSession({ name: 'disposed soft error' });
      sdkExpect.soft(1).toBe(2);
      expect(session.runId).toBe(opened.runId);
    })();
    await expect(disposedSession).rejects.toBeInstanceOf(AggregateError);
    expect(fake.stats().disposes).toBe(0);
    const failures = await opened.close();
    expect(failures.map((failure) => failure.message).join('\n')).toContain('worker disposal broke');
    await expect(opened[Symbol.asyncDispose]()).rejects.toBeInstanceOf(AggregateError);
    expect(await opened.close()).toEqual(failures);
    expect(fake.stats().disposes).toBe(1);
  });

  it('await using closes a successful host and its still-live session', async () => {
    const fake = createFakeEngine();
    const pool = provisioned(fake);
    let tracePath = '';
    {
      await using opened = await host(pool.engine);
      const session = await opened.openSession({ name: 'implicit close' });
      tracePath = session.tracePath;
      await session.fixtures.app.open();
    }
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(pool.finishes).toHaveLength(1);
    expect(readFileSync(tracePath, 'utf8')).toContain('app.open');
  });
});
