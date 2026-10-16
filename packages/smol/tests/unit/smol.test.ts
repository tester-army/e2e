/**
 * `smol()` against a mocked `smolmachines` and a stubbed DevTools `fetch`:
 * the warm machine an attempt-scope run boots once per slot and branches per
 * attempt, `prepare` and `setup`, the host-port relays, worker scope, cleanup
 * after a failed boot, `sweep`, and downloads.
 */

import path from 'node:path';
import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smol } from '../../src/index.ts';

const sdk = vi.hoisted(() => {
  const state = {
    created: [] as { config: Record<string, unknown>; conn: unknown }[],
    scripts: [] as { machine: string; script: string }[],
    branches: [] as { source: string; name: string; options: unknown }[],
    deleted: [] as string[],
    connected: [] as string[],
    connectedOptions: [] as unknown[],
    files: [] as { machine: string; path: string }[],
    machines: [] as string[],
    exitCode: 0,
    deleteFailures: new Map<string, Error>(),
    branchFailure: undefined as Error | undefined,
    createLockFailures: 0,
    blockAppShell: false,
    appShellEntered: undefined as (() => void) | undefined,
  };
  class Machine {
    constructor(readonly name: string) {
      state.machines.push(name);
    }
    static async create(config: Record<string, unknown>, conn: unknown): Promise<Machine> {
      if (state.createLockFailures > 0) {
        state.createLockFailures -= 1;
        throw new Error('database operation failed: configure pragmas: database is locked');
      }
      if (state.machines.includes(config.name as string)) throw new Error(`machine '${String(config.name)}' already exists`);
      state.created.push({ config, conn });
      return new Machine(config.name as string);
    }
    static async connect(name: string, options: unknown): Promise<Machine> {
      state.connected.push(name);
      state.connectedOptions.push(options);
      if (!state.machines.includes(name)) throw new Error(`machine not found: ${name}`);
      return new Machine(name);
    }
    static async list(): Promise<{ name: string }[]> {
      return state.machines.map((name) => ({ name }));
    }
    async exec(command: string[], opts?: { signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      state.scripts.push({ machine: this.name, script: command[2] ?? '' });
      if (state.blockAppShell && command[2]?.includes('tar -C /e2e-source')) {
        state.appShellEntered?.();
        if (!opts?.signal) throw new Error('app shell did not receive the launch signal');
        return new Promise((_, reject) => {
          if (opts.signal!.aborted) reject(opts.signal!.reason);
          else opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason), { once: true });
        });
      }
      return { exitCode: state.exitCode, stdout: '', stderr: state.exitCode === 0 ? '' : 'chromium did not start:\nno display' };
    }
    async branch(name: string, options: unknown): Promise<Machine> {
      state.branches.push({ source: this.name, name, options });
      const machine = new Machine(name);
      if (state.branchFailure !== undefined) throw state.branchFailure;
      return machine;
    }
    async delete(): Promise<void> {
      const failure = state.deleteFailures.get(this.name);
      if (failure !== undefined) throw failure;
      state.deleted.push(this.name);
      state.machines = state.machines.filter((name) => name !== this.name);
    }
    async readFile(file: string): Promise<Buffer> {
      state.files.push({ machine: this.name, path: file });
      return Buffer.from('file bytes');
    }
  }
  return { state, Machine };
});

vi.mock('smolmachines', () => ({ Machine: sdk.Machine }));

const fetched: string[] = [];

beforeEach(() => {
  Object.assign(sdk.state, { created: [], scripts: [], branches: [], deleted: [], connected: [], connectedOptions: [], files: [], machines: [], exitCode: 0, deleteFailures: new Map(), branchFailure: undefined, createLockFailures: 0, blockAppShell: false, appShellEntered: undefined });
  fetched.length = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    return new Response('{}');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'run-1',
    targetName: 'web',
    slot: 0,
    slots: 2,
    env: {},
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

function releaseContext(): BrowserReleaseContext {
  return { runId: 'run-1', targetName: 'web', env: {}, signal: new AbortController().signal, log: () => undefined };
}

/** The host port a published `{ host, guest }` port list names. */
function hostPortOf(ports: unknown): number {
  return (ports as { host: number }[])[0]!.host;
}

describe('smol()', () => {
  it('boots one warm browser per slot, prepares it once, and branches it for every attempt', async () => {
    const prepared: string[] = [];
    const provider = smol({ cpus: 4, memoryMb: 4096, prepare: async (endpoint) => void prepared.push(endpoint) });
    const first = request({ attemptId: 'a1' });
    const lease1 = await provider.acquire(first);
    const lease2 = await provider.acquire(request({ attemptId: 'a2' }));

    expect(sdk.state.created).toHaveLength(1);
    const { config, conn } = sdk.state.created[0]!;
    expect(conn).toEqual({ target: 'local', handleSignals: false });
    expect(config).toMatchObject({
      image: 'mcr.microsoft.com/playwright:v1.64.0-noble',
      network: true,
      branchable: true,
      waitForPorts: false,
      persistent: false,
      resources: { cpus: 4, memoryMb: 4096 },
      labels: { e2e_run: 'run-1', e2e_target: 'web' },
    });
    expect((config.ports as { guest: number }[])[0]!.guest).toBe(80);
    const warm = config.name as string;
    expect(warm).toMatch(/^e2e-[0-9a-f]{8}-w0-[0-9a-f]{12}$/);
    expect(prepared).toEqual([`http://127.0.0.1:${hostPortOf(config.ports)}`]);

    expect(sdk.state.branches.map(({ source }) => source)).toEqual([warm, warm]);
    expect(lease1.id).not.toBe(lease2.id);
    for (const [index, lease] of [lease1, lease2].entries()) {
      const branch = sdk.state.branches[index]!;
      expect(lease.id).toBe(branch.name);
      expect(lease.id.startsWith(`${warm}-`)).toBe(true);
      expect(lease.cdpEndpoint).toBe(`http://127.0.0.1:${hostPortOf((branch.options as { ports: unknown }).ports)}`);
      expect((branch.options as { ports: { guest: number }[] }).ports[0]!.guest).toBe(80);
      expect(fetched).toContain(`${lease.cdpEndpoint}/json/version`);
    }
    expect(first.lines).toEqual([expect.stringMatching(new RegExp(`^browser ${lease1.id}, branched from ${warm} in \\d+ ms$`))]);
  });

  it('runs setup before Chromium starts and relays each host port to the machine’s loopback', async () => {
    await smol({ setup: 'apt-get install -y fonts-noto-cjk', hostPorts: [3000, 4271] }).acquire(request({ attemptId: 'a1' }));
    const script = sdk.state.scripts[0]!.script;
    const order = ['fonts-noto-cjk', 'chrome=$(find /ms-playwright', "3000 'host.smolvm.internal' 3000", "4271 'host.smolvm.internal' 4271", "80 '127.0.0.1' 9229", '--headless=new', '/json/version'];
    const positions = order.map((needle) => script.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(script).toContain('--disable-features=BackForwardCache');
  });

  it('copies the app in, sets it up, starts it, and waits for it before prepare, all inside the machine', async () => {
    const prepared: string[] = [];
    await smol({
      app: { source: 'web', setup: 'npm ci', start: "node server.mjs --name 'demo'", port: 3000, env: { DATABASE_URL: "file:/app/db.sqlite?x='1'" } },
      prepare: async (endpoint) => void prepared.push(endpoint),
    }).acquire(request({ attemptId: 'a1' }));
    const { config } = sdk.state.created[0]!;
    expect(config.mounts).toEqual([{ source: path.resolve('web'), target: '/e2e-source', readOnly: true }]);
    expect(sdk.state.scripts).toHaveLength(2);
    const script = sdk.state.scripts[1]!.script;
    const order = [
      String.raw`export DATABASE_URL='file:/app/db.sqlite?x='\''1'\'''`,
      'tar -C /e2e-source --exclude=./node_modules --exclude=./.git --exclude=./.e2e -cf - . | tar -C /app -xf -',
      'cd /app',
      'npm ci',
      String.raw`nohup setsid sh -c 'node server.mjs --name '\''demo'\''' </dev/null >/tmp/e2e-app.log 2>&1 &`,
      'http://127.0.0.1:3000/',
    ];
    const positions = order.map((needle) => script.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(prepared).toHaveLength(1);
    // A 404 is still a response, while a refused connection reports code 000.
    expect(script).toContain('[ -n "$code" ] && [ "$code" != 000 ]');
  });

  it('refuses an app port the browser uses or that hostPorts also relays', () => {
    expect(() => smol({ app: { start: 'x', port: 80 } })).toThrow(/other than 80 and 9229/);
    expect(() => smol({ app: { start: 'x', port: 9229 } })).toThrow(/other than 80 and 9229/);
    expect(() => smol({ app: { start: 'x', port: 3000 }, hostPorts: [3000] })).toThrow(/both app.port and in hostPorts/);
  });

  it('refuses host ports the browser uses or that are not ports, before anything reaches a shell', () => {
    expect(() => smol({ hostPorts: [80] })).toThrow(/hostPorts entry must be a port from 1 to 65535 other than 80 and 9229, which the browser uses; got 80/);
    expect(() => smol({ hostPorts: ['3000; reboot' as unknown as number] })).toThrow(/hostPorts entry must be a port/);
    expect(() => smol({ hostPorts: [0] })).toThrow(/hostPorts entry must be a port/);
  });

  it('refuses an app.env name that is not a shell variable name', () => {
    expect(() => smol({ app: { start: 'x', port: 3000, env: { 'A B': '1' } } })).toThrow(/app.env name "A B" is not a shell variable name/);
    expect(() => smol({ app: { start: 'x', port: 3000, env: { '1X': '1' } } })).toThrow(/not a shell variable name/);
    expect(() => smol({ app: { start: 'x', port: 3000, env: { DATABASE_URL: 'x' } } })).not.toThrow();
  });

  it('boots a fresh warm machine when a failed attempt replaces its worker process', async () => {
    const firstWorker = smol();
    await firstWorker.acquire(request({ attemptId: 'a1' }));
    const firstName = sdk.state.created[0]!.config.name as string;

    // The old worker and its nonpersistent machine may still be stopping.
    const replacementWorker = smol();
    await replacementWorker.acquire(request({ attemptId: 'a2' }));
    const replacementName = sdk.state.created[1]!.config.name as string;

    expect(replacementName).not.toBe(firstName);
    expect(replacementName).toMatch(/^e2e-[0-9a-f]{8}-w0-[0-9a-f]+$/);
    expect(sdk.state.branches.map((branch) => branch.source)).toEqual([firstName, replacementName]);
  });

  it('reconnects to clean up a previous worker without waiting for its browser port', async () => {
    const previousWorker = smol();
    await previousWorker.acquire(request({ attemptId: 'a1' }));
    const orphan = sdk.state.created[0]!.config.name as string;

    const newWorker = smol();
    await newWorker.sweep!(releaseContext());
    expect(sdk.state.connected).toContain(orphan);
    expect(sdk.state.connectedOptions).toContainEqual({ target: 'local', handleSignals: false, waitForPorts: false });
  });

  it('retries an embedded database pragma lock during concurrent first boot', async () => {
    sdk.state.createLockFailures = 2;
    const provider = smol();
    await provider.acquire(request({ attemptId: 'a1' }));
    expect(sdk.state.createLockFailures).toBe(0);
    expect(sdk.state.created).toHaveLength(1);
  });

  it('boots a browser per slot without branching in worker scope, and deletes it on release', async () => {
    const provider = smol({ scope: 'worker' });
    const lease = await provider.acquire(request({ slot: 1 }));
    expect(lease.id).toMatch(/^e2e-[0-9a-f]{8}-s1-[0-9a-f]{6}$/);
    expect(sdk.state.created[0]!.config).toMatchObject({ persistent: true });
    expect(sdk.state.branches).toEqual([]);
    expect(provider.scope).toBe('worker');
    await provider.release(lease, releaseContext());
    expect(sdk.state.deleted).toEqual([lease.id]);
  });

  it('leases a replacement for a worker slot while the dropped browser is still held', async () => {
    const provider = smol({ scope: 'worker' });
    const dropped = await provider.acquire(request({ slot: 1 }));
    const replacement = await provider.acquire(request({ slot: 1 }));
    expect(replacement.id).not.toBe(dropped.id);
    expect(replacement.id.startsWith(dropped.id.slice(0, dropped.id.lastIndexOf('-') + 1))).toBe(true);
    const swept = await provider.sweep!(releaseContext());
    expect(swept.toSorted()).toEqual([dropped.id, replacement.id].toSorted());
  });

  it('refuses prepare in worker scope, where every attempt gets a new browser context', () => {
    expect(() => smol({ scope: 'worker', prepare: async () => undefined })).toThrow(/prepare needs scope "attempt"/);
  });

  it('deletes only the branch when an attempt ends, keeping the warm browser for the next one', async () => {
    const provider = smol();
    const lease = await provider.acquire(request({ attemptId: 'a1' }));
    await provider.release(lease, releaseContext());
    expect(sdk.state.deleted).toEqual([lease.id]);
    await provider.acquire(request({ attemptId: 'a2' }));
    expect(sdk.state.created).toHaveLength(1);
  });

  it('deletes a branch that fails partway, keeping the warm browser', async () => {
    const provider = smol();
    sdk.state.branchFailure = new Error('branch: agent did not answer');
    await expect(provider.acquire(request({ attemptId: 'a1' }))).rejects.toThrow(/agent did not answer/);
    expect(sdk.state.deleted).toEqual([sdk.state.branches[0]!.name]);
    sdk.state.branchFailure = undefined;
    await provider.acquire(request({ attemptId: 'a2' }));
    expect(sdk.state.created).toHaveLength(1);
  });

  it('deletes a machine whose browser does not start, and boots again on the next attempt', async () => {
    const provider = smol();
    sdk.state.exitCode = 1;
    await expect(provider.acquire(request({ attemptId: 'a1' }))).rejects.toThrow(/command exited 1: chromium did not start:; no display/);
    expect(sdk.state.deleted).toEqual([sdk.state.created[0]!.config.name]);
    sdk.state.exitCode = 0;
    await provider.acquire(request({ attemptId: 'a2' }));
    expect(sdk.state.created).toHaveLength(2);
    expect(sdk.state.created[1]!.config.name).not.toBe(sdk.state.created[0]!.config.name);
  });

  it('aborts an in-VM app launch, deletes the machine, and boots a fresh one on retry', async () => {
    const provider = smol({ app: { source: process.cwd(), start: 'node server.mjs', port: 3000 } });
    const controller = new AbortController();
    sdk.state.blockAppShell = true;
    const appStarted = new Promise<void>((resolve) => { sdk.state.appShellEntered = resolve; });
    const first = provider.acquire(request({ attemptId: 'a1', signal: controller.signal }));
    await appStarted;
    controller.abort(new Error('launch timed out'));
    sdk.state.blockAppShell = false;
    const replacement = provider.acquire(request({ attemptId: 'a2' }));
    await expect(first).rejects.toThrow('launch timed out');
    expect(sdk.state.deleted).toEqual([sdk.state.created[0]!.config.name]);
    await replacement;
    expect(sdk.state.created).toHaveLength(2);
    expect(sdk.state.created[1]!.config.name).not.toBe(sdk.state.created[0]!.config.name);
  });

  it('sweeps the run and target’s machines, branches before their source, and names what it could not delete', async () => {
    const provider = smol();
    const lease = await provider.acquire(request({ attemptId: 'a1' }));
    const warm = sdk.state.created[0]!.config.name as string;
    sdk.state.machines.push('e2e-ffffffff-w0', 'someone-elses');
    expect(await provider.sweep!(releaseContext())).toEqual([lease.id, warm]);
    expect(sdk.state.machines).toEqual(['e2e-ffffffff-w0', 'someone-elses']);

    await provider.acquire(request({ attemptId: 'a2', runId: 'run-2' }));
    const stuck = sdk.state.created[1]!.config.name as string;
    sdk.state.deleteFailures.set(stuck, new Error('busy'));
    vi.useFakeTimers();
    try {
      const sweep = expect(provider.sweep!({ ...releaseContext(), runId: 'run-2' })).rejects.toThrow(`could not delete ${stuck} (busy)`);
      await vi.runAllTimersAsync();
      await sweep;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a delete that fails while the engine is still stopping a machine', async () => {
    const provider = smol();
    await provider.acquire(request({ attemptId: 'a1' }));
    const warm = sdk.state.created[0]!.config.name as string;
    const branch = sdk.state.branches[0]!.name;
    sdk.state.deleteFailures.set(warm, new Error('guest did not confirm filesystem synchronization'));
    vi.useFakeTimers();
    try {
      const sweep = provider.sweep!(releaseContext());
      await vi.advanceTimersByTimeAsync(1);
      sdk.state.deleteFailures.delete(warm);
      await vi.runAllTimersAsync();
      expect(await sweep).toEqual([branch, warm]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a download off the leased browser’s disk', async () => {
    const provider = smol();
    const lease = await provider.acquire(request({ attemptId: 'a1' }));
    const bytes = await provider.downloads!.read(lease, '/tmp/e2e-downloads/report.csv', { runId: 'run-1', targetName: 'web', env: {}, signal: new AbortController().signal });
    expect(new TextDecoder().decode(bytes)).toBe('file bytes');
    expect(sdk.state.files).toEqual([{ machine: lease.id, path: '/tmp/e2e-downloads/report.csv' }]);
    expect(provider.downloads!.dir).toBe('/tmp/e2e-downloads');
  });
});
