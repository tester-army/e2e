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

/** What `orderWorkPlans` ranks the work by. */
interface WorkOrder {
  /** How likely the test filters rated a test to fail on this change, from 0 to 1; 0 for a test none scored. */
  readonly relevanceOf: (testId: string) => number;
  /** How long the previous run spent in a target's file; `undefined` when it has no timing, as every file does when the run reads none. */
  readonly durationOf: (targetName: string, file: string) => number | undefined;
}

/** The scores at which a test enters the next higher relevance band, so a score of at least 0.75 is band 3, and under 0.25 band 0. */
const RELEVANCE_EDGES: readonly number[] = [0.25, 0.5, 0.75];

/** The relevance band of a score: how many of `RELEVANCE_EDGES` it reaches. */
export function relevanceBand(score: number): number {
  return RELEVANCE_EDGES.filter((edge) => score >= edge).length;
}

/**
 * Orders each plan's file units, and the plans, so the work likeliest to fail
 * starts first and long files start early. A file ranks by the highest
 * relevance band of the tests it runs, and within a band longest first by
 * the time the previous run spent in it, so a long file starts while short
 * ones fill the other workers instead of starting last and running alone.
 * Files without a timing go first, being of unknown length; ties keep
 * collection order. A target ranks by its best file, ties keeping config
 * order. Report order does not depend on dispatch order.
 */
export function orderWorkPlans(plans: readonly TargetWorkPlan[], { relevanceOf, durationOf }: WorkOrder): TargetWorkPlan[] {
  const ranked = plans.map((plan) => {
    const units = plan.fileUnits
      .map((unit) => ({
        unit,
        band: unit.pairs.reduce((best, pair) => Math.max(best, relevanceBand(relevanceOf(pair.test.id))), 0),
        duration: durationOf(unit.targetName, unit.file) ?? Number.POSITIVE_INFINITY,
      }))
      .toSorted((a, b) => {
        const longer = b.duration - a.duration;
        return b.band - a.band || (Number.isNaN(longer) ? 0 : longer);
      });
    return { plan: { ...plan, fileUnits: units.map(({ unit }) => unit) }, band: units[0]?.band ?? 0 };
  });
  return ranked.toSorted((a, b) => b.band - a.band).map(({ plan }) => plan);
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

/** A run's time limit, in milliseconds, and where it was set: the `--max-duration` flag or the config's `maxDuration`. */
export interface TimeLimit {
  readonly ms: number;
  readonly source: '--max-duration' | 'maxDuration';
}

/** Skip info for the work a run stopped at its time limit never started. */
export function timeLimitSkip(limit: TimeLimit): SkipInfo {
  return {
    cause: 'time-limit',
    reason: `run stopped at its time limit of ${limit.ms} ms (${limit.source})`,
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

/**
 * The message of an attempt an interrupt cut short in `phase`, naming the
 * limit that stopped the run when the interrupt carried one.
 */
export function interruptedInPhase(signal: AbortSignal, phase: string): string {
  const reason: unknown = signal.reason;
  const message = `run interrupted in phase ${phase}`;
  return isSkipInfo(reason) ? `${message}: ${reason.reason}` : message;
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
