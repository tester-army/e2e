/**
 * The record of one exploration: the goal, its budgets, the steps the agent
 * planned and ran, and the findings it reported. One instance is shared by
 * the planner, the explorer's finding tool, the exploration body, and the
 * run's event spine, and its snapshot becomes `run.explore` in the report.
 * The state is the report boundary: every free text is bounded to the
 * schema's ceilings here, and nowhere else. Each change is announced to the
 * listeners `subscribe` registered, as `ExploreProgress`.
 */

import { timestamp, uuidv7 } from '../internal/ids.ts';
import type { ReportExplore, ReportExploreBaseline, ReportExploreFinding, ReportExploreStep } from '../report/build.ts';
import { BaselineMatcher, type LoadedBaseline } from './baseline.ts';
import type { ExploreBudgets, ExploreListener, ExploreProgress, OpenedStep } from './progress.ts';

export type { ExploreBudgets, OpenedStep } from './progress.ts';

/** A finding as the tool reports it; the state assigns identity, position, and time. */
export type FindingInput = Omit<ReportExploreFinding, 'id' | 'index' | 'step' | 'reportedAt' | 'novelty' | 'baselineFindingId'>;

/** Ceilings mirroring `schema/report-v1.schema.json` `explore`. */
export const MAX_TITLE_CHARS = 200;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_DETAIL_CHARS = 2_000;
const MAX_REPRODUCTION_STEPS = 20;
const MAX_REPRODUCTION_CHARS = 500;
const MAX_PATH_CHARS = 2_048;

interface OpenStep extends OpenedStep {
  readonly startedAt: string;
  readonly startedMs: number;
}

export class ExploreState {
  readonly steps: ReportExploreStep[] = [];
  readonly findings: ReportExploreFinding[] = [];
  #ended: ReportExplore['ended'] = 'aborted';
  #summary: string | undefined;
  #open: OpenStep | undefined;
  readonly #listeners: ExploreListener[] = [];
  /** Tells findings apart from an earlier run's, when the run was given a baseline. */
  readonly #baseline: BaselineMatcher | undefined;

  constructor(
    readonly goal: string,
    readonly budgets: ExploreBudgets,
    private readonly now: () => number = Date.now,
    baseline?: LoadedBaseline,
  ) {
    this.#baseline = baseline === undefined ? undefined : new BaselineMatcher(baseline);
  }

  /** Why exploration stopped; `aborted` until `end` says otherwise. */
  get ended(): ReportExplore['ended'] {
    return this.#ended;
  }

  /** The agent's closing assessment, once it gave one. */
  get summary(): string | undefined {
    return this.#summary;
  }

  /** Registers a listener for every change from here on. */
  subscribe(listener: ExploreListener): void {
    this.#listeners.push(listener);
  }

  #notify(progress: ExploreProgress): void {
    for (const listener of this.#listeners) listener(progress);
  }

  /** Announces the exploration beginning: the goal and its budgets. */
  start(): void {
    this.#notify({ phase: 'started', goal: this.goal, budgets: { maxSteps: this.budgets.maxSteps, timeoutMs: this.budgets.timeoutMs } });
  }

  /** Announces that the planner is deciding what comes next: a step, or the closing assessment. */
  planning(closing: boolean): void {
    this.#notify({ phase: 'planning', closing });
  }

  /** Opens the next step; the index is one-based. */
  beginStep(title: string, instruction: string): OpenedStep {
    if (this.#open !== undefined) throw new Error(`exploration step ${this.#open.index} is still open`);
    this.#open = {
      index: this.steps.length + 1,
      title: clip(title, MAX_TITLE_CHARS),
      instruction: clip(instruction, MAX_INSTRUCTION_CHARS),
      startedAt: timestamp(new Date(this.now())),
      startedMs: this.now(),
    };
    const { index, title: heading, instruction: charter } = this.#open;
    const step = { index, title: heading, instruction: charter };
    this.#notify({ phase: 'step-started', step });
    return step;
  }

  /** Closes the open step with its outcome. */
  endStep(status: ReportExploreStep['status'], summary?: string, errorCode?: string): ReportExploreStep {
    const open = this.#open;
    if (open === undefined) throw new Error('no exploration step is open');
    this.#open = undefined;
    const step: ReportExploreStep = {
      index: open.index,
      title: open.title,
      instruction: open.instruction,
      status,
      ...(summary === undefined || summary === '' ? {} : { summary: clip(summary, MAX_SUMMARY_CHARS) }),
      ...(errorCode === undefined ? {} : { errorCode }),
      startedAt: open.startedAt,
      durationMs: Math.max(0, this.now() - open.startedMs),
    };
    this.steps.push(step);
    this.#notify({ phase: 'step-finished', step });
    return step;
  }

  /**
   * Records one finding against the step in progress, with its evidence
   * screenshot's artifact id when one was kept, and, against a baseline,
   * whether it reads like a finding the earlier run already made.
   */
  addFinding(input: FindingInput): ReportExploreFinding {
    const known = this.#baseline?.match(input);
    const finding: ReportExploreFinding = {
      id: uuidv7(this.now()),
      index: this.findings.length,
      ...(this.#open === undefined ? {} : { step: this.#open.index }),
      kind: input.kind,
      severity: input.severity,
      title: clip(input.title, MAX_TITLE_CHARS),
      expected: clip(input.expected, MAX_DETAIL_CHARS),
      actual: clip(input.actual, MAX_DETAIL_CHARS),
      reproduction: input.reproduction.slice(0, MAX_REPRODUCTION_STEPS).map((entry) => clip(entry, MAX_REPRODUCTION_CHARS)),
      ...(input.path === undefined ? {} : { path: clip(input.path, MAX_PATH_CHARS) }),
      ...(input.observationRevision === undefined ? {} : { observationRevision: input.observationRevision }),
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      reportedAt: timestamp(new Date(this.now())),
      ...(this.#baseline === undefined ? {} : known === undefined ? { novelty: 'new' } : { novelty: 'known', baselineFindingId: known.id }),
    };
    this.findings.push(finding);
    this.#notify({ phase: 'finding', finding });
    return finding;
  }

  /** Closes the record: why exploration stopped and, when the agent gave one, its closing assessment. */
  end(ended: ReportExplore['ended'], summary?: string): void {
    this.#ended = ended;
    this.#summary = summary === undefined || summary.trim() === '' ? undefined : clip(summary, MAX_SUMMARY_CHARS);
    const baseline = this.baseline;
    this.#notify({ phase: 'finished', ended, summary: this.#summary, ...(baseline === undefined ? {} : { baseline }) });
  }

  /** How the baseline's findings fared against this run's so far; undefined without a baseline. */
  get baseline(): ReportExploreBaseline | undefined {
    const matcher = this.#baseline;
    if (matcher === undefined) return undefined;
    const known = this.findings.filter((finding) => finding.novelty === 'known').length;
    return {
      source: matcher.baseline.source,
      goal: matcher.baseline.goal,
      findings: matcher.baseline.findings.length,
      known,
      new: this.findings.length - known,
      notSeen: matcher.notSeen.map(({ id, kind, severity, title }) => ({ id, kind, severity, title })),
    };
  }

  get issues(): readonly ReportExploreFinding[] {
    return this.findings.filter((finding) => finding.kind === 'issue');
  }

  /**
   * How many steps in a row made no progress, newest first: failed or blocked
   * without recording a finding. A failed step that reported a defect did its
   * job, and a step that ended at its budget is a time-boxed charter, not a
   * failure; neither breaks the streak nor adds to it.
   */
  consecutiveFailures(): number {
    const productive = new Set(this.findings.map((finding) => finding.step));
    let count = 0;
    for (let index = this.steps.length - 1; index >= 0; index -= 1) {
      const step = this.steps[index]!;
      if (step.status === 'passed') break;
      if (step.status === 'exhausted' || productive.has(step.index)) continue;
      count += 1;
    }
    return count;
  }

  snapshot(): ReportExplore {
    return {
      goal: this.goal,
      budgets: { maxSteps: this.budgets.maxSteps, timeoutMs: this.budgets.timeoutMs },
      ended: this.#ended,
      ...(this.#summary === undefined ? {} : { summary: this.#summary }),
      steps: [...this.steps],
      findings: [...this.findings],
      ...(this.#baseline === undefined ? {} : { baseline: this.baseline }),
    };
  }
}

/**
 * Trims and bounds free text so the report stays inside the schema's
 * ceilings. Counted in code points, as the schema counts, so a cut never
 * splits a surrogate pair.
 */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  const points = Array.from(trimmed);
  return points.length <= max ? trimmed : `${points.slice(0, max - 1).join('')}…`;
}
