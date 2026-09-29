/**
 * Work-unit planning and the records for work the
 * scheduler reports without dispatching it. Every `ResultRecord` built from a
 * pair goes through `pairResult`, which narrows the pair's collected test to
 * its serializable identity.
 */

import path from 'node:path';
import type { Collection } from '../collect/collect.ts';
import { testIdentity } from '../collect/collect.ts';
import type { Selection, SkipInfo, TestTargetPair } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { ResultRecord } from './records.ts';
import type { WirePair } from './worker/protocol.ts';

/**
 * One schedulable unit: either a single setup pair or every runnable ordinary
 * pair of one file for one target. Units execute on exactly one worker.
 */
export interface WorkUnit {
  readonly id: string;
  readonly kind: 'setup' | 'file';
  readonly targetName: string;
  /** Normalized project-root-relative file path. */
  readonly file: string;
  readonly absolutePath: string;
  /** Pairs with disposition `run`, in declaration order. */
  readonly pairs: readonly TestTargetPair[];
}

/** Per-target schedule: setup units gate file units. */
export interface TargetWorkPlan {
  readonly target: ResolvedTarget;
  readonly setupUnits: readonly WorkUnit[];
  readonly fileUnits: readonly WorkUnit[];
  /** Non-run ordinary pairs the scheduler reports without dispatching. */
  readonly immediate: readonly TestTargetPair[];
  /** Worker cap the engine reported from `prepare`, over its declared `workers`. */
  readonly workers?: number;
  /** Variables the engine's `prepare` handed this target's workers; see `EnginePrepareResult.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Builds per-target work plans from a selection, preserving report order. */
export function buildWorkPlans(
  selection: Selection,
  collection: Collection,
  projectRoot: string,
): TargetWorkPlan[] {
  return selection.perTarget.map(({ target, pairs }) => {
    // One pass sorts every pair into its bucket; files are then visited in
    // collection order so unit order (and thus report order) is stable.
    const setupUnits: WorkUnit[] = [];
    const runnableByFile = new Map<string, TestTargetPair[]>();
    const immediate: TestTargetPair[] = [];
    for (const pair of pairs) {
      if (pair.test.kind === 'setup') {
        if (pair.disposition !== 'run') continue;
        setupUnits.push({
          id: `setup::${target.name}::${pair.test.id}`,
          kind: 'setup',
          targetName: target.name,
          file: pair.test.file,
          absolutePath: path.resolve(projectRoot, pair.test.file),
          pairs: [pair],
        });
      } else if (pair.disposition !== 'run') {
        immediate.push(pair);
      } else {
        const bucket = runnableByFile.get(pair.test.file);
        if (bucket === undefined) runnableByFile.set(pair.test.file, [pair]);
        else bucket.push(pair);
      }
    }

    const fileUnits: WorkUnit[] = [];
    for (const file of collection.files) {
      const filePairs = runnableByFile.get(file.file);
      if (filePairs === undefined) continue;
      fileUnits.push({
        id: `file::${target.name}::${file.file}`,
        kind: 'file',
        targetName: target.name,
        file: file.file,
        absolutePath: file.absolutePath,
        pairs: filePairs.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex),
      });
    }

    return { target, setupUnits, fileUnits, immediate };
  });
}

/**
 * The worker slots the run will start for a plan, `0` to `slots - 1`: the
 * run's worker cap, the engine's declared `workers`, and the units to
 * dispatch, whichever is smallest. A strict bound: a worker retired after a
 * failing unit holds its slot until it exits, so its replacement may take a
 * higher one, but never more slots than there are units to fail on.
 */
export function plannedSlots(plan: TargetWorkPlan, runWorkers: number): number {
  const units = plan.setupUnits.length + plan.fileUnits.length;
  return Math.min(runWorkers, plan.target.engine?.workers ?? runWorkers, units);
}

/** Skip info for a pair whose session-producing setup did not pass. */
export function setupFailedSkip(session: string, setupTestId: string): SkipInfo {
  return {
    cause: 'setup-failed',
    reason: `setup for session "${session}" failed`,
    relatedId: setupTestId,
  };
}

/** Skip info for runnable work an interrupt cancelled before it started. */
export const INTERRUPTED_BEFORE_START: SkipInfo = {
  cause: 'infrastructure-unavailable',
  reason: 'run interrupted before execution',
};

/** Whether a result counts toward `--max-failures`: a failed or timed-out one. */
export function countsTowardFailureLimit(status: ResultRecord['status']): boolean {
  return status === 'failed' || status === 'timed-out';
}

/** Skip info for the work a run stopped at its failure limit never started. */
export function failureLimitSkip(failures: number, limit: number): SkipInfo {
  return {
    cause: 'failure-limit',
    reason: `run stopped after ${failures} ${failures === 1 ? 'failure' : 'failures'} (--max-failures ${limit})`,
  };
}

/**
 * The skip for work an interrupt reached before it started: the skip the
 * interrupt carried as its reason (a run stopped at its failure limit says
 * so), else the plain interrupt.
 */
export function interruptedSkip(signal: AbortSignal, fallback: SkipInfo = INTERRUPTED_BEFORE_START): SkipInfo {
  const reason: unknown = signal.reason;
  return isSkipInfo(reason) ? reason : fallback;
}

function isSkipInfo(value: unknown): value is SkipInfo {
  return typeof value === 'object' && value !== null && typeof (value as SkipInfo).cause === 'string' && typeof (value as SkipInfo).reason === 'string';
}

/**
 * Builds a result for one pair, narrowing the collected test to its identity
 * so no test function or realm state can reach a record or the wire.
 */
export function pairResult(
  pair: TestTargetPair,
  fields: Omit<ResultRecord, 'test' | 'target' | 'agent' | 'repeat'>,
): ResultRecord {
  return { test: testIdentity(pair.test), target: pair.target, agent: pair.agent, repeat: pair.repeat, ...fields };
}

/** The artifact path segment of a `--repeat-each` run past the first; none for the first, whose paths do not change. */
export function repeatSegment(repeat: number): readonly string[] {
  return repeat === 0 ? [] : [`repeat-${repeat}`];
}

/** The identity of one pair among a unit's: a test runs once per agent it is pinned to, and once per repeat. */
export function pairKey(testId: string, agent: string, repeat: number): string {
  return `${testId}\u0000${agent}\u0000${repeat}`;
}

/** Result for a pair reported skipped or unselected without ever dispatching. */
export function nonRunResult(pair: TestTargetPair): ResultRecord {
  if (pair.disposition === 'skip') {
    return pairResult(pair, { status: 'skipped', selected: true, skip: pair.skip, attempts: [] });
  }
  return pairResult(pair, {
    status: 'skipped',
    selected: false,
    skip: pair.skip ?? { cause: 'filtered', reason: 'not selected' },
    attempts: [],
  });
}

/** Result for a runnable pair the run never started. */
export function unstartedResult(pair: TestTargetPair, skip: SkipInfo): ResultRecord {
  return pairResult(pair, {
    status: 'skipped',
    selected: pair.disposition === 'run',
    skip,
    attempts: [],
  });
}

/** Result for a test that vanished between planning and execution. */
export function disappearedResult(pair: WirePair, target: ResolvedTarget): ResultRecord {
  return { test: pair.test, target, agent: pair.agent, repeat: pair.repeat, status: 'failed', selected: true, attempts: [] };
}
