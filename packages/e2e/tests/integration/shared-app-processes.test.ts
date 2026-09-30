/**
 * `SharedAppProcesses` under `startDeclaredProcesses`, the one flow a run and
 * a live session both start app processes through: attempts on fresh loads
 * of one config share its app command, whatever else each opens, a process
 * that is stopping is started afresh only once it is gone, and a shared
 * start outlives the attempt that began it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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

describe('SharedAppProcesses', { timeout: 30_000 }, () => {
  let dir: string;
  let port: number;
  let url: string;
  let command: { readonly executable: string; readonly args: readonly string[] };
  /** Everything a test started, stopped after it whatever the test asserted. */
  let started: AppProcesses[];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-shared-apps-'));
    writeStartupScripts(dir);
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    command = { executable: process.execPath, args: ['server.cjs', String(port)] };
    started = [];
  });

  afterEach(async () => {
    for (const processes of started) await processes.stop(() => undefined);
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
  ) =>
    startDeclaredProcesses(
      config.targets.filter((target) => target.name === name),
      config.projectRoot,
      () => ({ ci: false }),
      signal,
      new DebugTrace(false),
      pool,
    ).then((processes) => {
      started.push(processes);
      return processes;
    });

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
    await second;
    expect(await serving()).toBe(true);
    await (await first).stop(() => undefined);
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
    await expect.poll(serving).toBe(true);
    cancel.abort();
    await (await opening).stop(() => undefined);
    expect(await serving()).toBe(false);
    // The next attempt starts it afresh rather than waiting on the abandoned start.
    const retry = new AbortController();
    const again = start(pool, config, 't0', retry.signal);
    await expect.poll(serving).toBe(true);
    retry.abort();
    await (await again).stop(() => undefined);
    expect(startupLog(dir)).toBe('app\napp\n');
  });
});
