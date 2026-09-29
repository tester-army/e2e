/**
 * Who starts the app processes an attempt declares. `UNSHARED` starts each
 * one for the attempt alone, as a run does; `SharedAppProcesses` hands every
 * attempt that declares the same process one instance of it, so live
 * sessions on one dev server share it. Either way the attempt starts and
 * stops through `startDeclaredProcesses`: the pool only decides whether a
 * process is started or reused.
 */

import { NEVER_ABORTS } from '../internal/time.ts';
import type { AppProcesses } from './provision.ts';

export interface ProcessPool {
  /**
   * One hold on the process `key` names, released by the returned `stop`.
   * `start` starts a fresh instance under the signal it is given: the
   * attempt's `signal`, or the pool's own lifetime for a shared process.
   */
  acquire(key: string, start: (signal: AbortSignal) => Promise<AppProcesses>, signal: AbortSignal): Promise<AppProcesses>;
}

/** Every attempt starts its own processes, under its own signal. */
export const UNSHARED: ProcessPool = { acquire: (_key, start, signal) => start(signal) };

interface SharedEntry {
  users: number;
  readonly started: Promise<AppProcesses>;
}

/**
 * One instance per process across attempts: the first attempt that declares
 * one starts it, and it stops when the last attempt holding it releases it,
 * so closing one live session never takes the dev server out from under
 * another. A process starts under the pool's lifetime, never the starting
 * attempt's signal, since it outlives that attempt; its notices and trace
 * spans still go to the attempt that started it. An attempt that arrives
 * while a process stops starts a fresh one once the stop is done.
 */
export class SharedAppProcesses implements ProcessPool {
  private readonly entries = new Map<string, SharedEntry>();
  /** Stops still running, by key. */
  private readonly draining = new Map<string, Promise<void>>();

  async acquire(key: string, start: (signal: AbortSignal) => Promise<AppProcesses>): Promise<AppProcesses> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      // A stop that failed has still ended its process: the fresh start goes ahead.
      const drained = (this.draining.get(key) ?? Promise.resolve()).catch(() => undefined);
      const created: SharedEntry = { users: 0, started: drained.then(() => start(NEVER_ABORTS)) };
      created.started.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
      this.entries.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.users += 1;
    const processes = await shared.started;
    return {
      stop: async (onFailure) => {
        shared.users -= 1;
        if (shared.users > 0) return;
        this.entries.delete(key);
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
}
