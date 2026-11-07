/**
 * The exploration's progress as the run's event spine carries it: one
 * `explore` run event per phase, so a reporter renders the exploration as it
 * happens (the step in progress, each finding the moment it is reported)
 * from the same stream every other sink receives. `run.explore` in the
 * report is the record; these are its moments.
 */

import type { ReportExplore, ReportExploreFinding, ReportExploreMerge, ReportExploreStep } from '../report/build.ts';

export interface ExploreBudgets {
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

/** A step as opened: title and charter bounded to the report's ceilings, which is what the step runs with. */
export type OpenedStep = Pick<ReportExploreStep, 'index' | 'title' | 'instruction'>;

export type ExploreProgress =
  /**
   * The exploration begins: its test has started and the app is about to
   * open. A parallel explorer adds its own focus label and every explorer's,
   * in order, so a reporter knows the explorers that have not started yet.
   */
  | {
      readonly phase: 'started';
      readonly goal: string;
      readonly budgets: ExploreBudgets;
      readonly focus?: string | undefined;
      readonly focuses?: readonly string[] | undefined;
    }
  /** The planner is deciding the next charter, or (`closing`) the assessment that ends the run. */
  | { readonly phase: 'planning'; readonly closing: boolean }
  | { readonly phase: 'step-started'; readonly step: OpenedStep }
  | { readonly phase: 'step-finished'; readonly step: ReportExploreStep }
  /** One finding, as recorded; its evidence screenshot, when kept, is the attempt artifact `artifactId` names. */
  | { readonly phase: 'finding'; readonly finding: ReportExploreFinding }
  | { readonly phase: 'finished'; readonly ended: ReportExplore['ended']; readonly summary?: string | undefined }
  /**
   * Parallel explorers only, once every explorer is over and a merge was
   * attempted: its outcome and usage, and the findings the report keeps.
   */
  | { readonly phase: 'merge'; readonly merge: ReportExploreMerge; readonly findings: readonly ReportExploreFinding[] };

export type ExploreListener = (progress: ExploreProgress) => void;

/** The virtual file of parallel explorer `explorer`, one-based. */
export function parallelExplorerFile(explorer: number): string {
  return `explore/${String(explorer)}`;
}

/** The parallel explorer whose virtual file `file` is, or undefined for any other file. */
export function explorerOfFile(file: string): number | undefined {
  const match = /^explore\/([1-9]\d*)$/.exec(file);
  return match === null ? undefined : Number(match[1]);
}
