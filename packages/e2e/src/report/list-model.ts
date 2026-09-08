/**
 * State the list reporter accumulates from the event stream, shared with the
 * live tree that paints the running part of it. Records, not rendered text:
 * each consumer renders at its own indent and width when it prints.
 */

import type { ResultStatus } from '../run/records.ts';
import type { StepEvent, StepKind, StepProgress } from '../run/steps.ts';
import type { AiUsage } from './format.ts';

/** Step events worth a glance in the live window; polls and policy decisions stay quiet. */
export type ShownEvent = StepEvent & { readonly kind: 'model' | 'engine' };

/** Whether an event is one the live window shows. */
export function isShownEvent(event: StepEvent): event is ShownEvent {
  return event.kind === 'model' || event.kind === 'engine';
}

/** The step a running pair is executing right now. */
export interface CurrentStep {
  readonly api: string;
  readonly label: string;
  /** Only an agent step has model turns to wait on. */
  readonly kind: StepKind;
  /**
   * Model turns and tool calls in causal order: each turn before the tool
   * calls it made. The executor reports a turn only after its tools ran, so
   * the turn is inserted ahead of them.
   */
  readonly events: ShownEvent[];
  /** Index in `events` where the tool calls of the turn still in flight begin. */
  turnStart: number;
}

/** One finished agent step of a pair, as the `end` progress reported it. */
export type FinishedStep = Pick<
  Extract<StepProgress, { phase: 'end' }>,
  'api' | 'label' | 'status' | 'durationMs' | 'modelCalls'
>;

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
  current: CurrentStep | undefined;
  /**
   * Finished agent steps across every attempt, oldest first. Shown under the
   * test in the live window while it runs, nested under its line in the file
   * block once it is done.
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

/** The setup step in flight, ticking in the live window: `starting service "postgres"`, `preparing playwright engine for target "web"`. */
export interface SetupInFlight {
  readonly verb: string;
  readonly subject: string;
  readonly startedMs: number;
}
