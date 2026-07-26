/** Work-unit planning for concurrent execution (spec 11-lifecycle.md). */

import path from 'node:path';
import type { Collection } from '../collect/collect.ts';
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

/** Result record for a pair reported skipped or unselected without dispatch. */
export function nonRunResult(pair: TestTargetPair): ResultRecord {
  if (pair.disposition === 'skip') {
    return {
      test: pair.test,
      target: pair.target,
      status: 'skipped',
      selected: true,
      skip: pair.skip,
      attempts: [],
    };
  }
  return {
    test: pair.test,
    target: pair.target,
    status: 'skipped',
    selected: false,
    skip: pair.skip ?? { cause: 'filtered', reason: 'not selected' },
    attempts: [],
  };
}

/** Result record for a runnable pair the run never dispatched. */
export function unstartedResult(pair: TestTargetPair, skip: SkipInfo): ResultRecord {
  return {
    test: pair.test,
    target: pair.target,
    status: 'skipped',
    selected: pair.disposition === 'run',
    skip,
    attempts: [],
  };
}
