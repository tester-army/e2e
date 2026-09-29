/**
 * `SharedAppProcesses` under `startDeclaredProcesses`, the one flow a run and
 * a live session both start app processes through: attempts share each app
 * command and each service they both declare, whatever URL each probes and
 * whatever else each adds, a process that is stopping is started afresh only
 * once it is gone, and a shared start outlives the attempt that began it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineAppDeclaration } from '../../src/engine/index.ts';
import type { AppProcesses } from '../../src/run/provision.ts';
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

  /** One resolved target per declaration, named t0, t1, and so on. */
  const targets = (...apps: EngineAppDeclaration[]) =>
    resolveConfig(
      { targets: apps.map((app, index) => ({ name: `t${index}`, platform: 'kiosk', engine: createFakeEngine({ app }).engine })) } as never,
      { projectRoot: dir, env: {} },
    ).targets;

  const start = (
    pool: InstanceType<typeof SharedAppProcesses>,
    target: ReturnType<typeof targets>[number],
    signal: AbortSignal = new AbortController().signal,
  ) =>
    startDeclaredProcesses([target], dir, () => ({ ci: false }), signal, new DebugTrace(false), pool).then((processes) => {
      started.push(processes);
      return processes;
    });

  const serving = async (): Promise<boolean> => fetch(url).then((response) => response.ok, () => false);

  it('shares the app command and the services two targets both declare, whatever URL each probes', async () => {
    const service = (name: string) => ({ name, executable: process.execPath, args: ['service.cjs', name], waitForExit: true });
    const [desktop, mobile] = targets({ url, command, services: [service('db')] }, { url: `${url}/m`, command, services: [service('db'), service('mail')] });
    const pool = new SharedAppProcesses();
    const first = await start(pool, desktop!);
    const second = await start(pool, mobile!);
    expect(startupLog(dir)).toBe('db\napp\nmail\n');
    await first.stop(() => undefined);
    expect(await serving()).toBe(true);
    await second.stop(() => undefined);
    expect(await serving()).toBe(false);
  });

  it('waits for a process that is stopping before it starts it again', async () => {
    const [target] = targets({ url, command });
    const pool = new SharedAppProcesses();
    const first = await start(pool, target!);
    const stopping = first.stop(() => undefined);
    const second = await start(pool, target!);
    await stopping;
    expect(startupLog(dir)).toBe('app\napp\n');
    expect(await serving()).toBe(true);
    await second.stop(() => undefined);
    expect(await serving()).toBe(false);
  });

  it('keeps starting a shared process when the attempt that began it is aborted', async () => {
    const [target] = targets({ url, command });
    const pool = new SharedAppProcesses();
    const aborted = new AbortController();
    const first = start(pool, target!, aborted.signal);
    aborted.abort();
    const second = await start(pool, target!);
    expect(await serving()).toBe(true);
    await (await first).stop(() => undefined);
    expect(await serving()).toBe(true);
    await second.stop(() => undefined);
    expect(await serving()).toBe(false);
  });
});
