/** A hosted session's deadline bounds polls, fixture calls, and engines that never answer. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineHandle } from '../../src/engine/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { gate, hostHarness, sdkExpect } from '../helpers/open-host.ts';

describe('openHost: deadline', { timeout: 60_000 }, () => {
  const { host, config } = hostHarness();

  it('bounds polls by config assertionTimeout and refreshes the deadline for the next session', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, { assertionTimeout: 40 }) });
    const first = await opened.openSession({ name: 'short poll', timeout: 200 });
    await expect(sdkExpect.poll(() => false, { interval: 5 }).toBe(true)).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('timed out after 40 ms') });
    expect(await first.close()).toEqual([]);
    const second = await opened.openSession({ name: 'fresh deadline', timeout: 5_000 });
    let reads = 0;
    await sdkExpect.poll(() => ++reads, { interval: 5, timeout: 500 }).toBeGreaterThan(2);
    await second.fixtures.app.open();
    const operation = fake.operations.find((entry) => entry.attemptId === second.attemptId);
    expect(operation?.timeoutMs).toBeGreaterThan(200);
    expect(operation?.runId).toBe(opened.runId);
    expect(await second.close()).toEqual([]);
  });

  it('caps contributed fixture calls at the session deadline and refuses dispatch after expiry', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'contributed deadline', timeout: 10 });
    await expect(session.fixtures.gadget.slow()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    await expect(session.fixtures.gadget.poke('too late')).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    expect(fake.fixtureCalls).toEqual(['slow']);
    expect(session.steps()).toContainEqual(expect.objectContaining({ api: 'gadget.slow', status: 'failed', error: expect.objectContaining({ code: 'TEST_TIMEOUT' }) }));
    await session.close();
    expect(readFileSync(session.tracePath, 'utf8')).toContain('timed out');
  });

  it('keeps the session deadline when a contributed operation disables its own timeout', async () => {
    const fake = createFakeEngine();
    const engine: EngineHandle = { ...fake.engine, fixtures: {
      gadget: (context) => context.fixture('gadget', {
        hang: async () => new Promise<never>(() => undefined),
      }, { hang: { kind: 'resource', timeout: false } }),
    } };
    const opened = await host(engine);
    const session = await opened.openSession({ name: 'disabled operation timeout', timeout: 15 });
    await expect(session.fixtures.gadget.hang()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    expect(await session.close()).toEqual([expect.objectContaining({ code: 'TEST_TIMEOUT' })]);
  });

  it('cuts a core operation the engine never finishes at the session deadline', async () => {
    const fake = createFakeEngine({ perform: () => new Promise<never>(() => undefined) });
    const opened = await host(fake.engine, { config: config(fake.engine, { actionTimeout: 30_000 }) });
    const session = await opened.openSession({ name: 'hung engine', timeout: 100 });
    const started = Date.now();
    await expect(session.fixtures.screen.getByRole('button', 'Submit').click()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(5_000);
    const failures = await session.close();
    expect(failures).toContainEqual(expect.objectContaining({ code: 'TEST_TIMEOUT', message: expect.stringContaining('session timed out after 100 ms') }));
    expect(readFileSync(session.tracePath, 'utf8')).toContain('timed out');
    const next = await opened.openSession({ name: 'after a hung engine', timeout: 5_000 });
    expect(await next.close()).toEqual([]);
  });

  it('refuses a session timeout that is not positive and finite', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(opened.openSession({ name: 'bad timeout', timeout })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(fake.stats().attemptsStarted).toBe(0);
    const session = await opened.openSession({ name: 'default timeout' });
    expect(await session.close()).toEqual([]);
  });

  it('records a blocked agent verdict as non-passing and retains failure-only video', async () => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', cache: 'off', agents: { default: { executor: {
        name: 'blocked-host-executor',
        async runStep() { return { status: 'blocked' as const, summary: 'cannot automate this surface', errorCode: 'AUTOMATION_UNSUPPORTED' as const }; },
      } } },
    }) });
    const session = await opened.openSession({ name: 'blocked automation' });
    await expect(session.fixtures.agent.act('unsupported operation')).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
    expect(session.steps().at(-1)?.status).toBe('blocked');
    await session.close();
    expect(readFileSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBeDefined();
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).toContain('AUTOMATION_UNSUPPORTED');
    expect(trace.split('\n')[0]).not.toContain('passed');
  });

  it('records a cancelled fixture as interrupted and retains failure-only video', async () => {
    const controller = new AbortController();
    const fake = createFakeEngine({ video: true, fixtures: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'cancelled operation', signal: controller.signal });
    const pending = session.fixtures.gadget.hang();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    await rejected;
    expect(session.steps().at(-1)?.status).toBe('cancelled');
    await session.close();
    expect(readFileSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBeDefined();
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).toContain('interrupted');
    expect(trace).toContain('CANCELLED');
    expect(trace.split('\n')[0]).not.toContain('passed');
  });

  it('caps an explicitly long poll at the session deadline', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'session deadline', timeout: 100 });
    // The poll stops itself at the deadline, or the session's cut lands first on a slow host: both tell the truth.
    const error: unknown = await sdkExpect.poll(() => false, { timeout: 30_000, interval: 5 }).toBe(true).catch((cause: unknown) => cause);
    expect(error).toSatisfy((cause: { code: string; message: string }) =>
      (cause.code === 'ASSERTION_FAILED' && cause.message.includes('attempt deadline')) || (cause.code === 'TEST_TIMEOUT' && cause.message.includes('session timed out')));
    // The poll's rejection is the caller's; close reports the session's own cut only when it landed before close.
    expect((await session.close()).map((failure) => failure.code)).toSatisfy((codes: string[]) => codes.every((code) => code === 'TEST_TIMEOUT'));
    const next = await opened.openSession({ name: 'after timeout', timeout: 5_000 });
    await sdkExpect.poll(() => true).toBe(true);
    expect(await next.close()).toEqual([]);
  });

  it.each(['session signal', 'host signal', 'session close', 'host close'] as const)('cancels an in-flight poll on %s', async (cancellation) => {
    const controller = new AbortController();
    const fake = createFakeEngine();
    const opened = await host(fake.engine, cancellation === 'host signal' ? { signal: controller.signal } : {});
    const session = await opened.openSession({ name: cancellation, timeout: 30_000, ...(cancellation === 'session signal' ? { signal: controller.signal } : {}) });
    const reading = gate();
    const poll = sdkExpect.poll(() => {
      reading.resolve();
      return new Promise<boolean>(() => undefined);
    }, { timeout: 30_000 }).toBe(true).then(() => 'passed', () => 'cancelled');
    await reading.promise;
    if (cancellation.endsWith('signal')) controller.abort();
    else if (cancellation === 'host close') await opened.close();
    else await session.close();
    expect(await poll).toBe('cancelled');
    await session.close();
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it('records abandoned polls and steps without unhandled rejections or reads after close', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'abandoned work' });
    let reads = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown) => { unhandled.push(cause); };
    process.on('unhandledRejection', onUnhandled);
    try {
      sdkExpect.poll(() => ++reads, { timeout: 30_000, interval: 5 }).toBe(-1);
      session.fixtures.gadget.hang();
      const failures = await session.close();
      expect(failures.map((failure) => failure.code)).toContain('STEP_NOT_AWAITED');
      expect(failures.map((failure) => failure.message).join('\n')).toContain('expect.poll');
      expect(session.steps()).toContainEqual(expect.objectContaining({ api: 'gadget.hang', status: 'failed', error: expect.objectContaining({ code: 'STEP_NOT_AWAITED' }) }));
      const readsAtClose = reads;
      const next = await opened.openSession({ name: 'after abandoned poll' });
      await sdkExpect.poll(() => true).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(readsAtClose);
      expect(unhandled).toEqual([]);
      expect(await next.close()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
