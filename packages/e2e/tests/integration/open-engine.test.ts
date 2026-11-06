/** `openEngine` through the built runner: one attempt on a bare engine, its fixtures, and a close that ends what it opened. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineHandle } from '../../src/engine/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const { openEngine } = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const PROJECTS = new URL('../tmp-projects/', import.meta.url);

describe('openEngine', { timeout: 60_000 }, () => {
  let dir: string;
  /** The process temp directory for the test, where openEngine keeps its output; empty at the start. */
  let temp: string;
  let previousTmpdir: string | undefined;

  beforeEach(() => {
    mkdirSync(PROJECTS, { recursive: true });
    dir = mkdtempSync(path.join(PROJECTS.pathname, 'open-engine-'));
    temp = mkdtempSync(path.join(PROJECTS.pathname, 'open-engine-tmp-'));
    previousTmpdir = process.env['TMPDIR'];
    process.env['TMPDIR'] = temp;
  });

  afterEach(() => {
    if (previousTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmpdir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  });

  it('hands back screen and the engine fixtures, then ends the attempt, disposes the engine once, and removes its output', async () => {
    const fake = createFakeEngine({ fixtures: true, platform: 'kiosk' });
    const engine = fake.engine as EngineHandle<{ gadget: { poke(what: string): Promise<string> } }>;
    const session = await openEngine(engine, { cwd: dir, env: {} });
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, attemptsEnded: 0 });
    // The output the close must remove: what the leak check below would see if it stayed.
    expect(readdirSync(temp)).toEqual([expect.stringMatching(/^e2e-engine-/)]);

    expect(await session.fixtures.screen.getByRole('button', 'Submit').count()).toBe(1);
    expect(await session.fixtures.gadget.poke('it')).toBe('poked it');

    await session.close();
    await session.close();
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(readdirSync(temp)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes its output when opening fails', async () => {
    const fake = createFakeEngine({ platform: 'kiosk', onInit: () => { throw new Error('the kiosk is unplugged'); } });
    await expect(openEngine(fake.engine, { cwd: dir, env: {} })).rejects.toThrow('the kiosk is unplugged');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('stops opening once the signal aborts, and removes its output', async () => {
    const controller = new AbortController();
    const fake = createFakeEngine({ platform: 'kiosk', onInit: () => controller.abort() });
    await expect(openEngine(fake.engine, { cwd: dir, env: {}, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.stats()).toMatchObject({ attemptsStarted: 0 });
    expect(readdirSync(temp)).toEqual([]);
  });

  it('cuts an operation that runs past the session timeout', async () => {
    const fake = createFakeEngine({
      platform: 'kiosk',
      // Answers only by giving up when its operation aborts.
      locate: (_expression, operation) => new Promise<readonly never[]>((_resolve, reject) => {
        operation.signal.addEventListener('abort', () => reject(operation.signal.reason as Error), { once: true });
      }),
    });
    const session = await openEngine(fake.engine, { cwd: dir, env: {}, timeout: 300 });
    try {
      const started = Date.now();
      await expect(session.fixtures.screen.getByRole('button', 'Submit').count()).rejects.toMatchObject({ code: expect.stringMatching(/TIMEOUT|TIMED_OUT/) });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await session.close().catch(() => undefined);
    }
    expect(readdirSync(temp)).toEqual([]);
  });

  it('closes everything it opened even when ending the attempt and disposing fail, and reports both', async () => {
    const fake = createFakeEngine({
      platform: 'kiosk',
      onEndAttempt: () => { throw new Error('the attempt would not end'); },
      onDispose: () => { throw new Error('the kiosk would not power down'); },
    });
    const session = await openEngine(fake.engine, { cwd: dir, env: {} });
    const closed = await session.close().then(() => undefined, (error: unknown) => error);
    expect(closed).toBeInstanceOf(AggregateError);
    expect((closed as AggregateError).message).toMatch(/the attempt would not end/);
    expect((closed as AggregateError).message).toMatch(/the kiosk would not power down/);
    expect((closed as AggregateError).errors).toHaveLength(2);
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(readdirSync(temp)).toEqual([]);
  });
});
