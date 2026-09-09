/**
 * The record of one exploration: the goal, its budgets, the steps the agent
 * planned and ran, and the findings it reported. One instance is shared by
 * the planner, the explorer's finding tool, the exploration body, and the
 * summary reporter, and its snapshot becomes `run.explore` in the report.
 */

import { timestamp, uuidv7 } from '../internal/ids.ts';
import type { ReportExplore, ReportExploreFinding, ReportExploreStep } from '../report/build.ts';

export interface ExploreBudgets {
  readonly maxSteps: number;
  readonly timeoutMs: number;
}

/** A finding as the tool reports it; the state assigns identity, position, and time. */
export type FindingInput = Omit<ReportExploreFinding, 'id' | 'index' | 'step' | 'reportedAt' | 'screenshot'>;

/** Ceilings mirroring `schema/report-v1.schema.json` `explore`. */
export const MAX_TITLE_CHARS = 200;
export const MAX_INSTRUCTION_CHARS = 2_000;
export const MAX_SUMMARY_CHARS = 4_000;
const MAX_DETAIL_CHARS = 2_000;
const MAX_REPRODUCTION_STEPS = 20;
const MAX_REPRODUCTION_CHARS = 500;
const MAX_PATH_CHARS = 2_048;

interface OpenStep {
  readonly index: number;
  readonly title: string;
  readonly instruction: string;
  readonly startedAt: string;
  readonly startedMs: number;
}

export class ExploreState {
  readonly steps: ReportExploreStep[] = [];
  readonly findings: ReportExploreFinding[] = [];
  /** The agent's closing assessment, once it gave one. */
  summary: string | undefined;
  /** Why exploration stopped; `aborted` until the body says otherwise. */
  ended: ReportExplore['ended'] = 'aborted';
  private open: OpenStep | undefined;

  constructor(
    readonly goal: string,
    readonly budgets: ExploreBudgets,
    private readonly now: () => number = Date.now,
  ) {}

  /** Opens the next step; the index is one-based. */
  beginStep(title: string, instruction: string): number {
    if (this.open !== undefined) throw new Error(`exploration step ${this.open.index} is still open`);
    const index = this.steps.length + 1;
    this.open = {
      index,
      title: clip(title, MAX_TITLE_CHARS),
      instruction: clip(instruction, MAX_INSTRUCTION_CHARS),
      startedAt: timestamp(new Date(this.now())),
      startedMs: this.now(),
    };
    return index;
  }

  /** Closes the open step with its outcome. */
  endStep(status: ReportExploreStep['status'], summary?: string, errorCode?: string): ReportExploreStep {
    const open = this.open;
    if (open === undefined) throw new Error('no exploration step is open');
    this.open = undefined;
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
    return step;
  }

  /** Records one finding against the step in progress. */
  addFinding(input: FindingInput): ReportExploreFinding {
    const finding: ReportExploreFinding = {
      id: uuidv7(this.now()),
      index: this.findings.length,
      ...(this.open === undefined ? {} : { step: this.open.index }),
      kind: input.kind,
      severity: input.severity,
      title: clip(input.title, MAX_TITLE_CHARS),
      expected: clip(input.expected, MAX_DETAIL_CHARS),
      actual: clip(input.actual, MAX_DETAIL_CHARS),
      reproduction: input.reproduction.slice(0, MAX_REPRODUCTION_STEPS).map((entry) => clip(entry, MAX_REPRODUCTION_CHARS)),
      ...(input.path === undefined ? {} : { path: clip(input.path, MAX_PATH_CHARS) }),
      ...(input.observationRevision === undefined ? {} : { observationRevision: input.observationRevision }),
      reportedAt: timestamp(new Date(this.now())),
    };
    this.findings.push(finding);
    return finding;
  }

  /** Attaches the evidence screenshot written for a finding. */
  attachEvidence(id: string, screenshot: string): void {
    const index = this.findings.findIndex((finding) => finding.id === id);
    if (index === -1) return;
    this.findings[index] = { ...this.findings[index]!, screenshot };
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
      ended: this.ended,
      ...(this.summary === undefined ? {} : { summary: clip(this.summary, MAX_SUMMARY_CHARS) }),
      steps: [...this.steps],
      findings: [...this.findings],
    };
  }
}

/** Trims and bounds free text so the report stays inside the schema's ceilings. */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
