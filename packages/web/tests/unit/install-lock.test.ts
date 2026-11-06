import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newOwner, removeAbandonedStaging, withCacheLock, writeOwner, type LockOwner } from '../../src/install-lock.ts';

const FAST = { heartbeatMs: 20, staleMs: 300, pollMs: 10 };

/** A pid that ran on this machine and has exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (pid === undefined) throw new Error('no pid');
  return pid;
}

let cache = '';
let lock = '';

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), 'e2e-lock-'));
  lock = path.join(cache, '.install.lock');
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

/** Leaves a lock in the cache as `owner` held it, its heartbeat `ageMs` old. */
function leaveLock(owner: LockOwner, ageMs = 0): void {
  mkdirSync(lock);
  writeOwner(lock, owner);
  const at = new Date(Date.now() - ageMs);
  utimesSync(path.join(lock, 'owner.json'), at, at);
}

describe('withCacheLock', () => {
  it('runs one holder at a time, says whom the waiter waits for, and removes the lock after', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    let releaseFirst = () => {};
    const first = withCacheLock(cache, { log: () => {} }, async () => {
      order.push('first start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first end');
    }, FAST);
    await sleep(30);
    const second = withCacheLock(cache, { log: (line) => logs.push(line) }, async () => {
      order.push('second');
    }, FAST);
    await sleep(100);
    expect(order).toEqual(['first start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^Waiting for another browser install into .* \\(pid ${String(process.pid)} on .*, started .*\\)\\.\\.\\.$`))]);
    expect(existsSync(lock)).toBe(false);
  });

  it('keeps a slow holder: its heartbeat outlives the stale age', async () => {
    const logs: string[] = [];
    const first = withCacheLock(cache, { log: () => {} }, () => sleep(FAST.staleMs * 3), FAST);
    await sleep(30);
    await withCacheLock(cache, { log: (line) => logs.push(line) }, async () => {}, FAST);
    await first;
    expect(logs.filter((line) => line.startsWith('Taking over'))).toEqual([]);
  });

  it('takes over at once from an owner on this machine that exited', async () => {
    const pid = deadPid();
    leaveLock({ ...newOwner(), pid });
    const logs: string[] = [];
    await withCacheLock(cache, { log: (line) => logs.push(line) }, async () => {}, { ...FAST, staleMs: 60_000 });
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^Taking over the browser install lock of pid ${String(pid)} on .*: pid ${String(pid)} exited$`))]);
    expect(existsSync(lock)).toBe(false);
  });

  it('waits for a live owner whose heartbeat is fresh, then takes over once it goes stale', async () => {
    leaveLock({ ...newOwner(), pid: process.ppid });
    const logs: string[] = [];
    const started = Date.now();
    await withCacheLock(cache, { log: (line) => logs.push(line) }, async () => {}, FAST);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.staleMs - 50);
    expect(logs[0]).toMatch(/^Waiting for another browser install/);
    expect(logs[1]).toMatch(/: no heartbeat for \d+s$/);
  });

  it('takes over from an owner on another machine only by its heartbeat', async () => {
    leaveLock({ ...newOwner(), host: `not-${os.hostname()}`, pid: deadPid() }, FAST.staleMs * 2);
    const logs: string[] = [];
    await withCacheLock(cache, { log: (line) => logs.push(line) }, async () => {}, FAST);
    expect(logs).toEqual([expect.stringMatching(/: no heartbeat for \d+s$/)]);
  });

  it('stops waiting with CANCELLED when the signal aborts, leaving the holder its lock', async () => {
    const holder = { ...newOwner(), pid: process.ppid };
    leaveLock(holder);
    const controller = new AbortController();
    const waiting = withCacheLock(cache, { log: () => controller.abort(), signal: controller.signal }, async () => {}, { ...FAST, staleMs: 60_000 });
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(existsSync(path.join(lock, 'owner.json'))).toBe(true);
  });

  it('leaves a lock another install took over', async () => {
    await withCacheLock(cache, { log: () => {} }, async () => {
      rmSync(lock, { recursive: true });
      leaveLock(newOwner());
    }, FAST);
    expect(existsSync(lock)).toBe(true);
  });
});

describe('removeAbandonedStaging', () => {
  it("removes a dead owner's staging beside the target and keeps a live one's", () => {
    const target = path.join(cache, 'firefox', 'mac_arm-stable_159.0.1');
    const dead = `${target}.partial-dead`;
    const live = `${target}.partial-live`;
    const unrelated = path.join(cache, 'firefox', 'mac_arm-stable_158.0.partial-dead');
    for (const dir of [dead, live, unrelated]) mkdirSync(dir, { recursive: true });
    writeOwner(dead, { ...newOwner(), pid: deadPid() });
    writeOwner(live, newOwner());
    writeOwner(unrelated, { ...newOwner(), pid: deadPid() });
    removeAbandonedStaging(target);
    expect(readdirSync(path.dirname(target)).toSorted()).toEqual(['mac_arm-stable_158.0.partial-dead', 'mac_arm-stable_159.0.1.partial-live']);
  });
});
