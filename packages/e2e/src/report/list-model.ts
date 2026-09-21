/**
 * State the list reporter accumulates from the event stream, shared with the
 * live tree that paints the running part of it. Records, not rendered text:
 * each consumer renders at its own indent and width when it prints.
 */

import type { ResultStatus } from '../run/records.ts';
import type { StepActivity, StepEvent, StepKind, StepProgress } from '../run/steps.ts';
import type { AiUsage } from './format.ts';

/** Step events worth a glance in the live window; polls and policy decisions stay quiet. */
export type ShownEvent = StepEvent & { readonly kind: 'model' | 'engine' };

/** Whether an event is one the live window shows. */
export function isShownEvent(event: StepEvent): event is ShownEvent {
  return event.kind === 'model' || event.kind === 'engine';
}

/** A step a running pair has open: the innermost is the one executing right now. */
export interface CurrentStep {
  /** The step id from the progress identity, to close the right one when steps nest. */
  readonly id: string | undefined;
  readonly api: string;
  readonly label: string;
  /** Only an agent step has model turns to wait on. */
  readonly kind: StepKind;
  /** How many `test.step` steps enclose it: the indent of its finished row. */
  readonly depth: number;
  /** Rows finished inside a `test.step`, waiting under it for its own row to head them. */
  readonly rows: FinishedStep[];
  /**
   * Model turns and tool calls in stream order. A tool-using executor
   * reports a turn once its tools ran, so the turn follows them here; its
   * `startedAt` still carries the moment the request went out.
   */
  readonly events: ShownEvent[];
  /**
   * True while the trace cache has the step, replaying its recorded actions:
   * no model is in the loop, so the wait between events is on the app.
   */
  replaying: boolean;
  /**
   * What the step waits on since its last event: a screen being read, an
   * action landing. Cleared by the event that reports the phase's end, so
   * with nothing announced the model is the one working.
   */
  activity: StepActivity | undefined;
}

/** One finished agent or `test.step` step of a pair, as the `end` progress reported it, with its indent. */
export type FinishedStep = Pick<
  Extract<StepProgress, { phase: 'end' }>,
  'api' | 'label' | 'status' | 'durationMs' | 'modelCalls'
> & { readonly depth: number };

/** A pair that has started and whose result is still to come. */
export interface RunningTest {
  readonly group: FileGroup;
  /** The pair's serial group, when it belongs to one. */
  readonly serialId: string | undefined;
  readonly title: string;
  readonly startedMs: number;
  /**
   * False once a later serial member replaced this one: it has finished
   * executing, but its result only arrives with the whole group.
   */
  executing: boolean;
  /** The steps open right now, outermost first; a `test.step` stays open while the steps it wraps run. */
  readonly open: CurrentStep[];
  /**
   * Finished agent and `test.step` rows that reached the top level across
   * every attempt, oldest first, a `test.step` above the rows it wrapped.
   * Shown under the test in the live window while it runs, nested under its
   * line in the file block once it is done. Without a window they print as
   * they finish instead, so this stays empty there.
   */
  readonly steps: FinishedStep[];
}

/** One finished pair, held until its file's block prints. */
export interface TestLine {
  readonly title: string;
  /** Source order within the file; blocks list tests as declared, not as finished. */
  readonly declarationIndex: number;
  readonly status: ResultStatus;
  readonly durationMs: number;
  readonly usage: AiUsage;
  readonly firstErrorLine: string | undefined;
  readonly skipReason: string | undefined;
  readonly steps: readonly FinishedStep[];
}

/**
 * Every pair of one test file on one target: vitest's "test module". Its
 * block prints once all planned results are in, so files never interleave.
 * Counts, durations, and usage derive from `lines`, so there is one source.
 */
export interface FileGroup {
  readonly file: string;
  readonly target: string;
  /** Reportable pairs the plan announced; undefined until the plan arrives. */
  planned: number | undefined;
  readonly lines: TestLine[];
  printed: boolean;
}

/** The setup step in flight, ticking in the live window: `starting service "postgres"`, `preparing web engine for target "web"`. */
export interface SetupInFlight {
  readonly verb: string;
  readonly subject: string;
  readonly startedMs: number;
}

/** The innermost open step of a running pair: the one executing right now. */
export function currentStep(running: RunningTest): CurrentStep | undefined {
  return running.open[running.open.length - 1];
}

/** Opens a step on a running pair, indented by the `test.step` steps already open around it. */
export function openStep(running: RunningTest, step: Pick<CurrentStep, 'id' | 'api' | 'label' | 'kind'>): void {
  const depth = running.open.filter((open) => open.kind === 'test').length;
  running.open.push({ ...step, depth, rows: [], events: [], replaying: false, activity: undefined });
}

/**
 * Closes the step `stepId` names on a running pair and returns it. A stream
 * without identity (older runners) closes the innermost open step, the only
 * one that can be ending there.
 */
export function closeStep(running: RunningTest, stepId: string | undefined): CurrentStep | undefined {
  const position = stepId === undefined ? running.open.length - 1 : running.open.findIndex((step) => step.id === stepId);
  return position < 0 ? undefined : running.open.splice(position, 1)[0];
}

/**
 * Files finished rows under the innermost open `test.step`, whose own row
 * will head them once it ends, and returns the rows that are inside none:
 * those are the pair's to show now. A `test.step`'s row brings the rows it
 * collected along, so ending one folds them out one level together.
 */
export function nestRows(running: RunningTest, rows: readonly FinishedStep[]): readonly FinishedStep[] {
  const wrapper = running.open.findLast((step) => step.kind === 'test');
  if (wrapper === undefined) return rows;
  wrapper.rows.push(...rows);
  return [];
}

/** Every row a running pair has: the top-level ones and those still waiting under an open `test.step`. */
export function finishedRows(running: RunningTest | undefined): FinishedStep[] {
  if (running === undefined) return [];
  return [...running.steps, ...running.open.flatMap((step) => step.rows)];
}
