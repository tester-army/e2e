/**
 * `SharedAppProcesses` under `startDeclaredProcesses`, the one flow a run and
 * a live session both start app processes through: attempts on fresh loads
 * of one config share its app command, whatever else each opens, a process
 * that is stopping is started afresh only once it is gone, and a shared
 * start outlives the attempt that began it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppProcesses } from '../../src/run/managed-process.ts';
import type { Target } from '../../src/types.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { startupLog, writeStartupScripts } from '../helpers/startup-scripts.ts';

const provisionModule = new URL('../../dist/run/provision.js', import.meta.url).href;
const { startDeclaredProcesses } = (await import(provisionModule)) as typeof import('../../src/run/provision.ts');
const poolModule = new URL('../../dist/run/process-pool.js', import.meta.url).href;
const { SharedAppProcesses } = (await import(poolModule)) as typeof import('../../src/run/process-pool.ts');
const resolveModule = new URL('../../dist/config/resolve.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve.ts');
const debugModule = new URL('../../dist/internal/debug.js', import.meta.url).href;
const { DebugTrace } = (await import(debugModule)) as typeof import('../../src/internal/debug.ts');

/** How long a test waits for the app process to start or exit: vitest's 1 s default is too short on a loaded machine. */
const PROCESS_POLL = { timeout: 5_000 };

describe('SharedAppProcesses', { timeout: 30_000 }, () => {
  let dir: string;
  let port: number;
  let url: string;
  let command: { readonly executable: string; readonly args: readonly string[] };
  /** Actual processes, with each stop shared by the pool and teardown. */
  let started: AppProcesses[];
  /** Calls waiting on the pool, which may reject before their processes stop. */
  let starting: Promise<unknown>[];
  /** Actual starts, including the cleanup they await when aborted. */
  let launching: Promise<unknown>[];
  /** Aborts the starts a failed test left waiting. */
  let teardown: AbortController;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-shared-apps-'));
    started = [];
    starting = [];
    launching = [];
    teardown = new AbortController();
    writeStartupScripts(dir);
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    command = { executable: process.execPath, args: ['server.cjs', String(port)] };
  });

  /** Stops both acquired processes and starts abandoned by their callers. */
  const stopProcesses = async () => {
    teardown.abort();
    await Promise.allSettled(starting);
    await Promise.allSettled(launching);
    for (const processes of started) await processes.stop(() => undefined);
  };

  afterEach(async () => {
    await stopProcesses();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One config load, as a live session loads it: one target per declaration, named t0, t1, and so on. */
  const load = (...declared: Pick<Target, 'app'>[]) =>
    resolveConfig(
      { targets: declared.map((target, index) => ({ name: `t${index}`, platform: 'kiosk', engine: createFakeEngine().engine, ...target })) } as never,
      { projectRoot: dir, env: {} },
    );

  const start = (
    pool: InstanceType<typeof SharedAppProcesses>,
    config: ReturnType<typeof load>,
    name = 't0',
    signal: AbortSignal = new AbortController().signal,
  ) => {
    const opening = startDeclaredProcesses(
      config.targets.filter((target) => target.name === name),
      config.projectRoot,
      () => ({ ci: false }),
      AbortSignal.any([signal, teardown.signal]),
      new DebugTrace(false),
      {
        acquire: (key, launch, requestSignal) => pool.acquire(key, (scope) => {
          const pending = launch(scope).then((processes) => {
            let stopping: Promise<void> | undefined;
            const tracked: AppProcesses = { stop: (onFailure) => stopping ??= processes.stop(onFailure) };
            started.push(tracked);
            return tracked;
          });
          launching.push(pending);
          return pending;
        }, requestSignal),
      },
    );
    starting.push(opening.catch(() => undefined));
    return opening;
  };

  const serving = async (): Promise<boolean> => fetch(url).then((response) => response.ok, () => false);

  it('shares the app command sessions on fresh loads both declare, whatever page each opens', async () => {
    /** A fresh load of one config: t0 opens the app's root, t1 a page of it, on one command. */
    const config = () => load({ app: { url, command } }, { app: { url: `${url}/m`, command } });
    const pool = new SharedAppProcesses();
    const first = await start(pool, config());
    const second = await start(pool, config(), 't1');
    const third = await start(pool, config());
    expect(startupLog(dir)).toBe('app\n');
    await first.stop(() => undefined);
    expect(await serving()).toBe(true);
    await third.stop(() => undefined);
    expect(await serving()).toBe(true);
    await second.stop(() => undefined);
    expect(await serving()).toBe(false);
  });

  it('waits for a process that is stopping before it starts it again', async () => {
    const config = load({ app: { url, command } });
    const pool = new SharedAppProcesses();
    const first = await start(pool, config);
    const stopping = first.stop(() => undefined);
    const second = await start(pool, config);
    await stopping;
    expect(startupLog(dir)).toBe('app\napp\n');
    expect(await serving()).toBe(true);
    await second.stop(() => undefined);
    expect(await serving()).toBe(false);
  });

  it('keeps starting a shared process when the attempt that began it is aborted while another waits', async () => {
    const config = load({ app: { url, command } });
    const pool = new SharedAppProcesses();
    const aborted = new AbortController();
    const first = start(pool, config, 't0', aborted.signal);
    const second = start(pool, config);
    aborted.abort();
    // The attempt that gave up stops waiting at once; the start goes on for the other.
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await second;
    expect(await serving()).toBe(true);
    await (await second).stop(() => undefined);
    expect(await serving()).toBe(false);
  });

  it('aborts a hung start once every attempt waiting on it gave up, stopping the process it started', async () => {
    // The server answers, but the readiness probe never does: the start hangs with the process up.
    const config = load({ app: { url, readyUrl: 'http://127.0.0.1:1/', command: { ...command, startupTimeout: 600_000 } } });
    const pool = new SharedAppProcesses();
    const cancel = new AbortController();
    const opening = start(pool, config, 't0', cancel.signal);
    await expect.poll(serving, PROCESS_POLL).toBe(true);
    cancel.abort();
    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    // Nobody holds the abandoned start, so the pool stops what it spawned.
    await expect.poll(serving, PROCESS_POLL).toBe(false);
    // The next attempt starts it afresh rather than waiting on the abandoned start.
    const retry = new AbortController();
    const again = start(pool, config, 't0', retry.signal);
    await expect.poll(serving, PROCESS_POLL).toBe(true);
    retry.abort();
    await expect(again).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(serving, PROCESS_POLL).toBe(false);
    expect(startupLog(dir)).toBe('app\napp\n');
  });

  it.skipIf(process.platform === 'win32')('waits for an abandoned process to finish shutting down before teardown removes its project', async () => {
    writeFileSync(path.join(dir, 'delayed-stop.cjs'), `
process.on('SIGTERM', () => setTimeout(() => {
  require('node:fs').writeFileSync('shutdown.log', 'stopped');
  process.exit(0);
}, 100));
require('./server.cjs');
`);
    const config = load({ app: {
      url,
      readyUrl: 'http://127.0.0.1:1/',
      command: { ...command, args: ['delayed-stop.cjs', String(port)], startupTimeout: 600_000 },
    } });
    const opening = start(new SharedAppProcesses(), config);
    await expect.poll(serving, PROCESS_POLL).toBe(true);

    await stopProcesses();

    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await serving()).toBe(false);
    expect(readFileSync(path.join(dir, 'shutdown.log'), 'utf8')).toBe('stopped');
  });

  it.skipIf(process.platform === 'win32')('waits for a stop already running in the pool when teardown begins', async () => {
    const stoppingFile = path.join(dir, 'stopping');
    const releaseFile = path.join(dir, 'release-stop');
    writeFileSync(path.join(dir, 'gated-stop.cjs'), `
const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.writeFileSync('stopping', 'started');
  setInterval(() => {
    if (fs.existsSync('release-stop')) process.exit(0);
  }, 10);
});
require('./server.cjs');
`);
    const config = load({ app: { url, command: { ...command, args: ['gated-stop.cjs', String(port)] } } });
    const first = await start(new SharedAppProcesses(), config);
    const stopping = first.stop(() => undefined);
    let cleaning: Promise<void> | undefined;
    try {
      await expect.poll(() => existsSync(stoppingFile), PROCESS_POLL).toBe(true);
      let cleaned = false;
      cleaning = stopProcesses().then(() => { cleaned = true; });
      // An HTTP round trip also lets a prematurely completed teardown finish its microtasks.
      expect(await serving()).toBe(true);
      expect(cleaned).toBe(false);
    } finally {
      writeFileSync(releaseFile, 'released');
      await stopping;
      await cleaning;
    }
    expect(await serving()).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps the project until shutdown completes in the actual afterEach hook', async ({ onTestFinished }) => {
    const evidence = mkdtempSync(path.join(os.tmpdir(), 'e2e-shared-apps-shutdown-'));
    const receipt = path.join(evidence, 'shutdown.json');
    onTestFinished(async () => {
      try {
        expect(await serving()).toBe(false);
        expect(existsSync(dir)).toBe(false);
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ projectExists: true });
      } finally {
        await stopProcesses();
        rmSync(dir, { recursive: true, force: true });
        rmSync(evidence, { recursive: true, force: true });
      }
    });
    writeFileSync(path.join(dir, 'observed-stop.cjs'), `
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ projectExists: fs.existsSync(${JSON.stringify(dir)}) }));
  process.exit(0);
}, 100));
require('./server.cjs');
`);
    const config = load({ app: {
      url,
      readyUrl: 'http://127.0.0.1:1/',
      command: { ...command, args: ['observed-stop.cjs', String(port)], startupTimeout: 600_000 },
    } });
    void start(new SharedAppProcesses(), config);
    await expect.poll(serving, PROCESS_POLL).toBe(true);
  });
});
