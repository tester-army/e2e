/**
 * The exploration's progress as the run's event spine carries it: one
 * `explore` run event per phase, so a reporter renders the exploration as it
 * happens (the step in progress, each finding the moment it is reported)
 * from the same stream every other sink receives. `run.explore` in the
 * report is the record; these are its moments.
 */

import type { ReportExplore, ReportExploreFinding, ReportExploreStep } from '../report/build.ts';

export interface ExploreBudgets {
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

/** A step as opened: title and charter bounded to the report's ceilings, which is what the step runs with. */
export type OpenedStep = Pick<ReportExploreStep, 'index' | 'title' | 'instruction'>;

export type ExploreProgress =
  /** The exploration begins: its test has started and the app is about to open. */
  | { readonly phase: 'started'; readonly goal: string; readonly budgets: ExploreBudgets }
  /** The planner is deciding the next charter, or the closing assessment. */
  | { readonly phase: 'planning' }
  | { readonly phase: 'step-started'; readonly step: OpenedStep }
  | { readonly phase: 'step-finished'; readonly step: ReportExploreStep }
  /** One finding, as recorded; its evidence screenshot, when kept, is the attempt artifact `artifactId` names. */
  | { readonly phase: 'finding'; readonly finding: ReportExploreFinding }
  | { readonly phase: 'finished'; readonly ended: ReportExplore['ended']; readonly summary?: string | undefined };

export type ExploreListener = (progress: ExploreProgress) => void;
