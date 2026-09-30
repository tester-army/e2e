/**
 * Who starts the app processes an attempt declares. `UNSHARED` starts each
 * one for the attempt alone, as a run does; `SharedAppProcesses` hands every
 * attempt that declares the same process one instance of it, so live
 * sessions on one dev server share it. Either way the attempt starts and
 * stops through `startDeclaredProcesses`: the pool only decides whether a
 * process is started or reused.
 */

import type { AppProcesses } from './managed-process.ts';

export interface ProcessPool {
  /**
   * One hold on the process `key` names, released by the returned `stop`.
   * `start` starts a fresh instance under the signal it is given: the
   * attempt's `signal`, or for a shared process one that aborts once no
   * attempt waits on the start any more.
   */
  acquire(key: string, start: (signal: AbortSignal) => Promise<AppProcesses>, signal: AbortSignal): Promise<AppProcesses>;
}

/** Every attempt starts its own processes, under its own signal. */
export const UNSHARED: ProcessPool = { acquire: (_key, start, signal) => start(signal) };

interface SharedEntry {
  users: number;
  /** Set once the start settled: from then on an attempt giving up abandons nothing. */
  settled: boolean;
  /** Attempts still waiting on the start whose own signal has not aborted. */
  waiting: number;
  /** Aborts the start once no attempt waits on it any more. */
  readonly abandon: AbortController;
  readonly started: Promise<AppProcesses>;
}

/**
 * One instance per process across attempts: the first attempt that declares
 * one starts it, and it stops when the last attempt holding it releases it,
 * so closing one live session never takes the dev server out from under
 * another. A shared start outlives the attempt that began it while another
 * still waits on it, and is aborted once every attempt waiting on it gave up
 * (a cancelled request, a server shutting down), so a hung start never
 * leaves what it started behind; the next attempt starts it afresh. Its
 * notices and trace spans still go to the attempt that started it. An
 * attempt that arrives while a process stops starts a fresh one once the
 * stop is done.
 */
export class SharedAppProcesses implements ProcessPool {
  private readonly entries = new Map<string, SharedEntry>();
  /** Stops still running, and starts abandoned, by key. */
  private readonly draining = new Map<string, Promise<unknown>>();

  async acquire(key: string, start: (signal: AbortSignal) => Promise<AppProcesses>, signal: AbortSignal): Promise<AppProcesses> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      // A stop that failed has still ended its process: the fresh start goes ahead.
      const drained = (this.draining.get(key) ?? Promise.resolve()).catch(() => undefined);
      const abandon = new AbortController();
      const created: SharedEntry = { users: 0, settled: false, waiting: 0, abandon, started: drained.then(() => start(abandon.signal)) };
      created.started.then(
        () => {
          created.settled = true;
        },
        () => {
          created.settled = true;
          this.forget(key, created);
        },
      );
      this.entries.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.users += 1;
    shared.waiting += 1;
    const giveUp = (): void => {
      shared.waiting -= 1;
      if (shared.waiting > 0 || shared.settled) return;
      shared.abandon.abort();
      this.forget(key, shared);
      this.draining.set(key, shared.started.catch(() => undefined));
    };
    if (signal.aborted) giveUp();
    else signal.addEventListener('abort', giveUp, { once: true });
    let processes: AppProcesses;
    try {
      processes = await shared.started;
    } catch (cause) {
      shared.users -= 1;
      throw cause;
    } finally {
      signal.removeEventListener('abort', giveUp);
      if (!signal.aborted) shared.waiting -= 1;
    }
    return {
      stop: async (onFailure) => {
        shared.users -= 1;
        if (shared.users > 0) return;
        this.forget(key, shared);
        const stopping = processes.stop(onFailure);
        this.draining.set(key, stopping);
        try {
          await stopping;
        } finally {
          if (this.draining.get(key) === stopping) this.draining.delete(key);
        }
      },
    };
  }

  /** Drops `entry` from the pool, unless a fresh start already took its key. */
  private forget(key: string, entry: SharedEntry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}
