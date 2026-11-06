/**
 * The browsers cache's install lock and the owner identity it records.
 * One process installs into a cache at a time; the holder refreshes a
 * heartbeat while it works, and a waiter takes over a lock whose holder
 * died or stopped beating. Staging directories carry the same owner, so a
 * takeover never removes a live owner's files.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EngineError } from 'e2e/engine';

/** Who holds a lock or a staging directory. */
export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  /** When the owning process started, in epoch milliseconds. */
  readonly startedAt: number;
  /** Unique per acquisition, so a lock taken over and taken again is told apart. */
  readonly token: string;
}

/** How often the lock's heartbeat is refreshed, how old one may get, and how often a waiter looks again. */
export interface LockTiming {
  readonly heartbeatMs: number;
  readonly staleMs: number;
  readonly pollMs: number;
}

const DEFAULT_TIMING: LockTiming = { heartbeatMs: 5_000, staleMs: 60_000, pollMs: 500 };

/** A staging directory with no owner record yet is abandoned once this old. */
const UNOWNED_STAGING_MS = 60 * 60_000;

/** The owner record's name inside a lock or staging directory. */
const OWNER_FILE = 'owner.json';

/** A fresh owner identity for this process. */
export function newOwner(): LockOwner {
  return { pid: process.pid, host: os.hostname(), startedAt: Math.round(Date.now() - process.uptime() * 1000), token: randomUUID() };
}

/** Writes `owner` into `directory` as its owner record. */
export function writeOwner(directory: string, owner: LockOwner): void {
  writeFileSync(path.join(directory, OWNER_FILE), JSON.stringify(owner));
}

/** The owner record in `directory`, or undefined when there is none or it is not readable yet. */
function readOwner(directory: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(directory, OWNER_FILE), 'utf8'));
    if (typeof value !== 'object' || value === null) return undefined;
    const { pid, host, startedAt, token } = value as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof token !== 'string') return undefined;
    return { pid, host, startedAt: typeof startedAt === 'number' ? startedAt : 0, token };
  } catch {
    return undefined;
  }
}

/** Whether `owner` is a process on this machine that no longer runs. */
function isOwnerDead(owner: Pick<LockOwner, 'pid' | 'host'>): boolean {
  if (owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** The milliseconds since `file` changed, or undefined when it is gone. */
function ageOf(file: string): number | undefined {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Rejects with `CANCELLED` once `signal` aborted. */
export function cancelledCheck(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new EngineError('CANCELLED', 'browser install cancelled', { retryable: false });
}

/** The lock's holder as a waiter sees it: its record, and how long since its heartbeat. */
interface Holder {
  readonly owner: LockOwner | undefined;
  readonly silentMs: number;
}

/** The holder of `lock`, or undefined when the lock is gone. The heartbeat is the owner record's mtime, else the directory's. */
function holderOf(lock: string): Holder | undefined {
  const silentMs = ageOf(path.join(lock, OWNER_FILE)) ?? ageOf(lock);
  if (silentMs === undefined) return undefined;
  return { owner: readOwner(lock), silentMs };
}

/** Why `holder` no longer holds its lock, or undefined while it does. */
function abandonment(holder: Holder, timing: LockTiming): string | undefined {
  if (holder.owner !== undefined && isOwnerDead(holder.owner)) return `pid ${String(holder.owner.pid)} exited`;
  if (holder.silentMs > timing.staleMs) return `no heartbeat for ${String(Math.round(holder.silentMs / 1000))}s`;
  return undefined;
}

/** Describes `owner` for a log line. */
function describe(owner: LockOwner | undefined): string {
  if (owner === undefined) return 'an install that is starting';
  return `pid ${String(owner.pid)} on ${owner.host}, started ${new Date(owner.startedAt).toISOString()}`;
}

/**
 * Moves the abandoned `lock` aside and removes it. When the lock turned out
 * to be a newer one than the holder judged abandoned, it is put back.
 */
function takeOver(lock: string, judged: Holder): void {
  const aside = `${lock}.stale-${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  if (readOwner(aside)?.token !== judged.owner?.token) {
    try {
      renameSync(aside, lock);
      return;
    } catch {
      // A third install took the lock meanwhile; the moved one is gone either way.
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

/** What `withCacheLock` reports to and stops on. */
export interface LockContext {
  readonly log: (line: string) => void;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Runs `work(owner)` holding the install lock of `cacheDir`, a directory
 * only one process can create, which records its owner and whose heartbeat
 * is refreshed every `heartbeatMs` while `work` runs. A waiter logs who it
 * waits for, takes over a lock whose owner exited on this machine or whose
 * heartbeat is older than `staleMs`, and stops with `CANCELLED` on `signal`.
 */
export async function withCacheLock<T>(
  cacheDir: string,
  context: LockContext,
  work: (owner: LockOwner) => Promise<T>,
  timing: LockTiming = DEFAULT_TIMING,
): Promise<T> {
  mkdirSync(cacheDir, { recursive: true });
  const lock = path.join(cacheDir, '.install.lock');
  const owner = newOwner();
  let reported: string | undefined;
  for (;;) {
    cancelledCheck(context.signal);
    try {
      mkdirSync(lock);
      writeOwner(lock, owner);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = holderOf(lock);
    if (holder === undefined) continue;
    const reason = abandonment(holder, timing);
    if (reason !== undefined) {
      context.log(`Taking over the browser install lock of ${describe(holder.owner)}: ${reason}`);
      takeOver(lock, holder);
      continue;
    }
    const key = holder.owner?.token ?? '';
    if (key !== reported) {
      context.log(`Waiting for another browser install into ${cacheDir} (${describe(holder.owner)})...`);
      reported = key;
    }
    try {
      await sleep(timing.pollMs, undefined, context.signal === undefined ? {} : { signal: context.signal });
    } catch {
      cancelledCheck(context.signal);
    }
  }
  const beat = setInterval(() => {
    const now = new Date();
    try {
      utimesSync(path.join(lock, OWNER_FILE), now, now);
    } catch {
      // Taken over: the work finishes in its own staging directory either way.
    }
  }, timing.heartbeatMs);
  try {
    return await work(owner);
  } finally {
    clearInterval(beat);
    if (readOwner(lock)?.token === owner.token) rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Removes the staging directories beside `target` (`<target>.partial-*`)
 * whose owner exited on this machine, or that never got an owner record and
 * are an hour old. A live owner's, or one on another machine, stays.
 */
export function removeAbandonedStaging(target: string): void {
  const prefix = `${path.basename(target)}.partial-`;
  let entries: string[];
  try {
    entries = readdirSync(path.dirname(target)).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  for (const name of entries) {
    const staging = path.join(path.dirname(target), name);
    const owner = readOwner(staging);
    const abandoned = owner === undefined ? (ageOf(staging) ?? 0) > UNOWNED_STAGING_MS : isOwnerDead(owner);
    if (abandoned) rmSync(staging, { recursive: true, force: true });
  }
}
