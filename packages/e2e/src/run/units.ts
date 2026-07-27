/**
 * Work-unit planning (spec 11-lifecycle.md) and the records for work the
 * scheduler reports without dispatching it. Every `ResultRecord` built from a
 * pair goes through `pairResult`, which narrows the pair's collected test to
 * its serializable identity.
 */

import path from 'node:path';
import type { Collection, TestIdentity } from '../collect/collect.ts';
import { testIdentity } from '../collect/collect.ts';
import type { Selection, SkipInfo, TestTargetPair } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { ResultRecord } from './records.ts';

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
}

/** Builds per-target work plans from a selection, preserving report order. */
export function buildWorkPlans(
  selection: Selection,
  collection: Collection,
  projectRoot: string,
): TargetWorkPlan[] {
  return selection.perTarget.map(({ target, pairs }) => {
    const setupUnits: WorkUnit[] = pairs
      .filter((pair) => pair.test.kind === 'setup' && pair.disposition === 'run')
      .map((pair) => ({
        id: `setup::${target.name}::${pair.test.id}`,
        kind: 'setup' as const,
        targetName: target.name,
        file: pair.test.file,
        absolutePath: path.resolve(projectRoot, pair.test.file),
        pairs: [pair],
      }));

    const fileUnits: WorkUnit[] = [];
    for (const file of collection.files) {
      const filePairs = pairs
        .filter(
          (pair) =>
            pair.test.file === file.file &&
            pair.test.kind === 'test' &&
            pair.disposition === 'run',
        )
        .toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
      if (filePairs.length === 0) continue;
      fileUnits.push({
        id: `file::${target.name}::${file.file}`,
        kind: 'file',
        targetName: target.name,
        file: file.file,
        absolutePath: file.absolutePath,
        pairs: filePairs,
      });
    }

    const immediate = pairs.filter(
      (pair) => pair.test.kind === 'test' && pair.disposition !== 'run',
    );

    return { target, setupUnits, fileUnits, immediate };
  });
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

/**
 * Builds a result for one pair, narrowing the collected test to its identity
 * so no test function or realm state can reach a record or the wire.
 */
export function pairResult(
  pair: TestTargetPair,
  fields: Omit<ResultRecord, 'test' | 'target'>,
): ResultRecord {
  return { test: testIdentity(pair.test), target: pair.target, ...fields };
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
export function disappearedResult(test: TestIdentity, target: ResolvedTarget): ResultRecord {
  return { test, target, status: 'failed', selected: true, attempts: [] };
}
