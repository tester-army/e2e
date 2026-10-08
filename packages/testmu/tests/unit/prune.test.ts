/**
 * `testmu()` pruning the state directories earlier runs left under
 * `stateDir`: once per provider, only directories it marked as its own whose
 * newest file is older than a day, never the current run's, and never
 * failing the lease; and the marker it writes and keeps fresh.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceRequest } from '@e2e-dev/mobile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmu, type TestmuOptions } from '../../src/index.ts';

vi.mock('agent-device', () => ({
  createAgentDeviceClient: () => ({
    leases: {
      allocate: async (options: Record<string, unknown>) => ({ leaseId: 'lease-1', tenantId: options['tenant'], runId: options['runId'] }),
      heartbeat: async () => ({}),
      release: async () => ({ released: true }),
    },
  }),
}));

const options: TestmuOptions = { device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'lt://APP1', stateDir: 'state' };
const CURRENT_RUN = '01a0fc76-002f-736c-991a-fa4778d0543e';
const OLD_RUN = '01a0e000-0000-7000-8000-000000000001';
const RECENT_RUN = '01a0e000-0000-7000-8000-000000000002';
/** A file named like a run: only directories are pruned. */
const RUN_FILE = '01a0e000-0000-7000-8000-000000000003';
/** A directory named like a run that another tool keeps under the same directory. */
const FOREIGN_RUN = '01a0e000-0000-7000-8000-000000000004';
/** A marked run, still going in another process, whose daemon wrote its log recently. */
const LONG_RUN = '01a0e000-0000-7000-8000-000000000005';
const MARKER = '.e2e-testmu-run';
const HOUR = 60 * 60_000;
const MINUTE = 60_000;

let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'testmu-prune-'));
  base = join(root, 'state');
  mkdirSync(base);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Sets a path's modification time `ageMs` ago. */
function age(path: string, ageMs: number): void {
  const time = new Date(Date.now() - ageMs);
  utimesSync(path, time, time);
}

/** A run directory under the state directory with a daemon log, marked as the provider's unless `marked` is false, every entry `ageMs` old. */
function runDir(name: string, ageMs: number, { marked = true } = {}): void {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon.log'), 'log');
  age(join(dir, 'daemon.log'), ageMs);
  if (marked) {
    writeFileSync(join(dir, MARKER), '');
    age(join(dir, MARKER), ageMs);
  }
  age(dir, ageMs);
}

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: CURRENT_RUN,
    targetName: 'android',
    slot: 0,
    slots: 1,
    projectRoot: root,
    agentDeviceVersion: '0.21.18',
    env: { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key' },
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

describe('testmu() state directory pruning', () => {
  it("removes earlier runs' marked directories older than a day, and keeps the current run's, recent ones, and anything it did not mark", async () => {
    runDir(OLD_RUN, 25 * HOUR);
    runDir(RECENT_RUN, 23 * HOUR);
    runDir(CURRENT_RUN, 48 * HOUR);
    runDir(FOREIGN_RUN, 48 * HOUR, { marked: false });
    runDir('notes', 48 * HOUR);
    writeFileSync(join(base, RUN_FILE), 'a file');
    age(join(base, RUN_FILE), 48 * HOUR);
    await testmu(options).acquire(request());
    expect(readdirSync(base).toSorted()).toEqual([CURRENT_RUN, FOREIGN_RUN, RECENT_RUN, RUN_FILE, 'notes'].toSorted());
  });

  it('keeps a marked run whose daemon wrote a file within the day, however old its marker and directory', async () => {
    runDir(LONG_RUN, 30 * HOUR);
    age(join(base, LONG_RUN, 'daemon.log'), HOUR);
    age(join(base, LONG_RUN), 30 * HOUR);
    await testmu(options).acquire(request());
    expect(existsSync(join(base, LONG_RUN))).toBe(true);
  });

  it("marks the run's directory when it leases, and touches the marker on every heartbeat", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const provider = testmu(options);
      const lease = await provider.acquire(request());
      const marker = join(base, CURRENT_RUN, MARKER);
      expect(statSync(marker).isFile()).toBe(true);
      age(marker, 30 * HOUR);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      await vi.waitFor(() => expect(Date.now() - statSync(marker).mtimeMs).toBeLessThan(HOUR));
      await provider.release(lease, { runId: CURRENT_RUN, targetName: 'android', env: {}, signal: new AbortController().signal, log: () => undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes once per provider, on its first acquire', async () => {
    const provider = testmu(options);
    await provider.acquire(request());
    runDir(OLD_RUN, 25 * HOUR);
    await provider.acquire(request({ slot: 1, slots: 2 }));
    expect(existsSync(join(base, OLD_RUN))).toBe(true);
  });

  it('leases a device when there is nothing to prune or pruning fails', async () => {
    await expect(testmu({ ...options, stateDir: 'missing' }).acquire(request())).resolves.toMatchObject({ id: 'lease-1' });
    writeFileSync(join(root, 'plain-file'), 'not a directory');
    await expect(testmu({ ...options, stateDir: 'plain-file' }).acquire(request())).resolves.toMatchObject({ id: 'lease-1' });
  });
});
