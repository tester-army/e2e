/**
 * Protocol between the scheduler and one target worker. Every message is
 * JSON-serializable so the same shapes work over a child-process IPC channel
 * and in-process (see `run/unit-runner.ts`). Two things deliberately never
 * cross: `ResolvedTarget`, which may hold a live driver instance, and test
 * functions. Work units therefore carry `TestIdentity` and the worker pairs
 * each identity with a locally resolved test function.
 */

import type { TestIdentity } from '../../collect/collect.ts';
import type { ResolvedTestOptions } from '../../collect/select.ts';
import type { CliOverrides, ResolvedTarget } from '../../config/resolve.ts';
import type { DebugSnapshot } from '../../internal/debug.ts';
import type { SerializedError } from '../../internal/errors.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from '../records.ts';
import type { StepProgress } from '../steps.ts';

/** One runnable pair on the wire; the worker resolves the test function. */
export interface WirePair {
  readonly test: TestIdentity;
  readonly options: ResolvedTestOptions;
}

/**
 * Bootstrap payload for a child-process worker. Transport-private: the
 * scheduler never builds one, because run-wide settings are closed over by the
 * spawn factory rather than sent as a message.
 */
export interface WorkerBootstrapMessage {
  readonly type: 'bootstrap';
  readonly bootstrap: WorkerBootstrap;
}

/** Everything a child-process worker can receive. */
export type ChildProcessInbound = WorkerBootstrapMessage | MainToWorker;

export interface WorkerBootstrap {
  readonly configPath: string;
  readonly projectRoot: string;
  readonly configDigest: string;
  /**
   * The runner's command-line overrides. A worker re-resolves the config from
   * the same file, so without these it would silently disagree with the runner
   * about anything a flag changed — `--retries` among them. The config digest covers only the file, so the mismatch check cannot
   * catch it.
   */
  readonly cli: CliOverrides;
  readonly targetName: string;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly headed: boolean;
  readonly sessionsRoot: string;
  /** Per-run AES key; transferred only over this channel, never disk or env. */
  readonly sessionKeyBase64: string;
  /** Whether the worker should collect `--debug` phase timings. */
  readonly debug: boolean;
}

export interface RunUnitMessage {
  readonly type: 'run-unit';
  readonly unitId: string;
  readonly kind: 'setup' | 'file';
  readonly file: string;
  readonly absolutePath: string;
  readonly pairs: readonly WirePair[];
}

export interface InterruptMessage {
  readonly type: 'interrupt';
}

export interface ShutdownMessage {
  readonly type: 'shutdown';
}

export type MainToWorker = RunUnitMessage | InterruptMessage | ShutdownMessage;

/**
 * `ResultRecord` minus the live target. Serializable as-is: `test` is a
 * `TestIdentity` and every other field is plain data.
 */
export type WireResultRecord = Omit<ResultRecord, 'target'>;

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface PairStartMessage {
  readonly type: 'pair-start';
  readonly testId: string;
  /** Joined title path, so reporters need no side lookup by test ID. */
  readonly title: string;
}

/** Live step progress of the running attempt; plain data, fire-and-forget. */
export interface ProgressMessage {
  readonly type: 'progress';
  readonly testId: string;
  readonly progress: StepProgress;
}

export interface ResultMessage {
  readonly type: 'result';
  readonly result: WireResultRecord;
}

export interface SerialGroupMessage {
  readonly type: 'serial-group';
  readonly group: SerialGroupRecord;
}

export interface UnitDoneMessage {
  readonly type: 'unit-done';
  readonly unitId: string;
  readonly runErrors: readonly RunError[];
  /** Phase timings drained from this worker since the previous unit. */
  readonly debug?: DebugSnapshot;
}

export interface FatalMessage {
  readonly type: 'fatal';
  readonly error: SerializedError;
}

export type WorkerToMain =
  | ReadyMessage
  | PairStartMessage
  | ProgressMessage
  | ResultMessage
  | SerialGroupMessage
  | UnitDoneMessage
  | FatalMessage;

/** Strips the live target from a result for transport. */
export function encodeResult(record: ResultRecord): WireResultRecord {
  const { target: _target, ...rest } = record;
  return rest;
}

/** Reattaches the scheduler's resolved target to a wire result. */
export function decodeResult(wire: WireResultRecord, target: ResolvedTarget): ResultRecord {
  return { ...wire, target };
}
