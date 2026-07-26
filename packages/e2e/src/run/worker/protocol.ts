/**
 * IPC protocol between the runner (scheduler) and worker processes. Messages
 * cross a JSON channel: functions (for example `CollectedTest.fn`) are dropped
 * in transit, and `ResolvedTarget` never crosses because it may hold a live
 * driver instance; results carry `targetName` and the runner rehydrates.
 */

import type { CollectedTest } from '../../collect/collect.ts';
import type { ResolvedTestOptions } from '../../collect/select.ts';
import type { ResolvedTarget } from '../../config/resolve.ts';
import type { SerializedError } from '../../internal/errors.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from '../records.ts';

/** One runnable pair on the wire: the worker rebuilds the test by re-collecting. */
export interface WirePair {
  readonly testId: string;
  readonly options: ResolvedTestOptions;
}

export interface InitMessage {
  readonly type: 'init';
  readonly configPath: string;
  readonly projectRoot: string;
  readonly configDigest: string;
  readonly targetName: string;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly headed: boolean;
  readonly sessionsRoot: string;
  /** Per-run AES key; transferred only over this channel. */
  readonly sessionKeyBase64: string;
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

export type MainToWorker = InitMessage | RunUnitMessage | InterruptMessage | ShutdownMessage;

/** `ResultRecord` with the non-serializable target replaced by its name. */
export interface WireResultRecord extends Omit<ResultRecord, 'target'> {
  readonly targetName: string;
}

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface PairStartMessage {
  readonly type: 'pair-start';
  readonly unitId: string;
  readonly testId: string;
}

export interface ResultMessage {
  readonly type: 'result';
  readonly unitId: string;
  readonly result: WireResultRecord;
}

export interface SerialGroupMessage {
  readonly type: 'serial-group';
  readonly unitId: string;
  readonly group: SerialGroupRecord;
}

export interface UnitDoneMessage {
  readonly type: 'unit-done';
  readonly unitId: string;
  readonly runErrors: readonly RunError[];
}

export interface FatalMessage {
  readonly type: 'fatal';
  readonly error: SerializedError;
}

export type WorkerToMain =
  | ReadyMessage
  | PairStartMessage
  | ResultMessage
  | SerialGroupMessage
  | UnitDoneMessage
  | FatalMessage;

/** Strips the live target from a result for IPC transport. */
export function encodeResult(record: ResultRecord): WireResultRecord {
  const { target, ...rest } = record;
  return { ...rest, targetName: target.name };
}

/** Reattaches the runner's resolved target to a wire result. */
export function decodeResult(wire: WireResultRecord, target: ResolvedTarget): ResultRecord {
  const { targetName, ...rest } = wire;
  void targetName;
  return { ...rest, test: rest.test as CollectedTest, target };
}
