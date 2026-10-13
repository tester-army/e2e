/** A hosted worker owns its engine instance from before prepare until clean teardown. */
import { describe, expect, it } from 'vitest';
import type { EngineFinishInfo, EngineHandle } from '../../src/engine/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { gate, hostHarness, provisioned, sdkExpect } from '../helpers/open-host.ts';

describe('openHost: engine ownership', { timeout: 60_000 }, () => {
  const { host, heldGate } = hostHarness();

  it('releases engine ownership after clean worker teardown despite a live session soft failure', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    await opened.openSession({ name: 'soft failure during host close' });
    sdkExpect.soft(1).toBe(2);
    expect(await opened.close()).toContainEqual(expect.objectContaining({ code: 'ASSERTION_FAILED' }));
    expect(fake.stats().disposes).toBe(1);
    const replacement = await host(pool.engine);
    const next = await replacement.openSession({ name: 'cleanly reacquired engine' });
    expect(await next.fixtures.gadget.poke('reused')).toBe('poked reused');
    expect(await replacement.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 2, disposes: 2 });
    expect(pool.prepares).toHaveLength(2);
    expect(pool.finishes).toHaveLength(2);
  });

  it('rejects a duplicate engine owner before prepare or init without disposing the live host, then permits clean reuse', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const session = await opened.openSession({ name: 'original engine owner' });
    await expect(host(pool.engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(pool.prepares).toHaveLength(1);
    expect(pool.finishes).toHaveLength(0);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, disposes: 0 });
    expect(await session.fixtures.gadget.poke('still usable')).toBe('poked still usable');
    await session.fixtures.app.open();
    expect(await session.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(pool.finishes).toHaveLength(1);
    expect(fake.stats().disposes).toBe(1);
    const replacement = await host(pool.engine);
    const next = await replacement.openSession({ name: 'reused after clean worker teardown' });
    expect(await next.fixtures.gadget.poke('new owner')).toBe('poked new owner');
    expect(await next.close()).toEqual([]);
    expect(await replacement.close()).toEqual([]);
    expect(pool.prepares).toHaveLength(2);
    expect(pool.finishes).toHaveLength(2);
    expect(fake.stats()).toMatchObject({ inits: 2, attemptsStarted: 2, disposes: 2 });
  });

  it('claims an engine before asynchronous prepare so concurrent host construction cannot enter its hooks', async () => {
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine({ fixtures: true });
    let prepares = 0;
    const engine: EngineHandle = { ...fake.engine, async prepare() {
      prepares += 1;
      entered.resolve();
      await release.promise;
    } };
    const opening = host(engine);
    await entered.promise;
    await expect(host(engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(prepares).toBe(1);
    expect(fake.stats()).toMatchObject({ inits: 0, disposes: 0, attemptsStarted: 0 });
    release.resolve();
    const opened = await opening;
    const session = await opened.openSession({ name: 'prepare owner survived' });
    expect(await session.fixtures.gadget.poke('after prepare')).toBe('poked after prepare');
    expect(await session.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, disposes: 1 });
  });

  it.each(['dispose', 'finish'] as const)('retains the engine lease until asynchronous worker %s completes', async (hook) => {
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine(hook === 'dispose' ? { onDispose: async () => { entered.resolve(); await release.promise; } } : {});
    const pool = provisioned(fake);
    const engine: EngineHandle = { ...pool.engine, ...(hook === 'finish' ? { async finish(info: EngineFinishInfo) {
      entered.resolve();
      await release.promise;
      await pool.engine.finish?.(info);
    } } : {}) };
    const opened = await host(engine);
    const closing = opened.close();
    await entered.promise;
    await expect(host(engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(pool.prepares).toHaveLength(1);
    expect(fake.stats().inits).toBe(1);
    expect(fake.stats().disposes).toBe(1);
    release.resolve();
    expect(await closing).toEqual([]);
    const replacement = await host(engine);
    expect(pool.prepares).toHaveLength(2);
    expect(fake.stats().inits).toBe(2);
    expect(await replacement.close()).toEqual([]);
  });

  it.each(['dispose', 'finish'] as const)('fails closed on duplicate engine reuse after worker %s fails', async (hook) => {
    const fake = createFakeEngine(hook === 'dispose' ? { onDispose: () => { throw new Error('unsafe worker dispose'); } } : {});
    const pool = provisioned(fake);
    const engine: EngineHandle = { ...pool.engine, ...(hook === 'finish' ? { async finish(info: EngineFinishInfo) {
      await pool.engine.finish?.(info);
      throw new Error('unsafe worker finish');
    } } : {}) };
    const opened = await host(engine);
    const failures = await opened.close();
    expect(failures.map((failure) => failure.message).join('\n')).toContain(`unsafe worker ${hook}`);
    await expect(host(engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(await opened.close()).toEqual(failures);
    expect(pool.prepares).toHaveLength(1);
    expect(pool.finishes).toHaveLength(1);
    expect(fake.stats()).toMatchObject({ inits: 1, disposes: 1 });
  });
});
