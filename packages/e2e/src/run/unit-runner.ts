/**
 * The seam between the scheduler and whatever actually executes work units.
 *
 * The scheduler only ever talks to a `UnitRunner`: it sends work-unit messages
 * and reacts to record messages coming back. Two implementations exist — a
 * child process (`worker/handle.ts`, the default) and an in-process runner
 * (`in-process.ts`, used when the config cannot cross a process boundary).
 * Keeping this interface narrow is what lets one scheduler own all execution.
 */

import type { MainToWorker, WorkerToMain } from './worker/protocol.ts';

export interface UnitRunnerEvents {
  onMessage(message: WorkerToMain): void;
  /**
   * Fires exactly once when the runner reaches end of life, for any reason.
   * `detail` describes the cause for infrastructure error reporting.
   */
  onExit(detail: string): void;
}

/** One worker bound to a single target, executing at most one unit at a time. */
export interface UnitRunner {
  /** Resolves when the runner has exited; never rejects. */
  readonly exit: Promise<void>;
  readonly alive: boolean;
  send(message: MainToWorker): void;
  /** Terminates without waiting for in-flight work to unwind. */
  kill(): void;
}

/** Creates a runner for one target. Run-wide settings are closed over. */
export type SpawnUnitRunner = (targetName: string, events: UnitRunnerEvents) => UnitRunner;
