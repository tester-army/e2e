/**
 * Structured run events (`e2e/run`): the run's single event spine.
 *
 * Every event is plain JSON data — the same records the report persists and
 * the worker IPC already carries, so a host can stream them over any wire
 * without touching live handles. The list reporter consumes exactly this
 * stream (`ListReporter.handle`, report/list.ts), so the CLI's rendering and a
 * host's dashboard can never drift: there is one dispatch, not two. The
 * report stays the canonical record; the stream exists so consumers can
 * render progress while the run is still going.
 *
 * The emitter is the single writer: it stamps `seq` and `at`, so ordering
 * survives any transport that preserves per-connection order. A sink that
 * throws is quarantined for the rest of the run; a sink whose returned
 * promise rejects is quarantined once the rejection settles, so events
 * emitted before then may still reach it. Either way a broken consumer can
 * never fail the run.
 */

import type { SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import type { ResultRecord, SerialGroupRecord } from './records.ts';
import type { StepProgress } from './steps.ts';
import { encodeResult, type WireResultRecord } from './worker/protocol.ts';

/** The closed set of process exit codes a run can end with. */
export type RunExitCode = 0 | 1 | 2 | 3 | 4 | 130;

/**
 * `ResultRecord` minus the live resolved target (the wire encoding the worker
 * IPC already uses), plus the target's stable identity so a consumer can
 * attribute the result without a side lookup.
 */
export interface RunEventResult extends WireResultRecord {
  readonly target: { readonly name: string; readonly platform: string };
}

/** One fact about the run; the emitter wraps it in the envelope. */
export type RunEventFact =
  | {
      readonly type: 'run-started';
      readonly runId: string;
      readonly projectId: string;
      readonly projectRoot: string;
      readonly ci: boolean;
      readonly targets: readonly string[];
    }
  | { readonly type: 'plan'; readonly total: number }
  | {
      readonly type: 'test-started';
      readonly testId: string;
      readonly title: string;
      readonly target: string;
    }
  | {
      readonly type: 'step';
      readonly testId: string;
      readonly target: string;
      readonly progress: StepProgress;
    }
  | { readonly type: 'test-finished'; readonly result: RunEventResult }
  | { readonly type: 'serial-group'; readonly group: SerialGroupRecord }
  | { readonly type: 'run-error'; readonly error: SerializedError }
  | {
      readonly type: 'run-finished';
      readonly status: 'passed' | 'failed' | 'error' | 'interrupted';
      readonly exitCode: RunExitCode;
      readonly reportPath?: string;
      /** Where `--ai-trace` wrote the run's model calls, once the file exists. */
      readonly aiTracePath?: string;
    };

/** Envelope stamped by the emitter: monotonic order and wall-clock time. */
export interface RunEventHeader {
  readonly seq: number;
  readonly at: string;
}

export type RunEvent = RunEventHeader & RunEventFact;

/** The fact of one event type, for a consumer that handles types one at a time. */
export type RunEventOf<Type extends RunEventFact['type']> = Extract<RunEventFact, { type: Type }>;

/**
 * An event consumer. Must not block; a throw — or, when it returns a
 * promise, a rejection — quarantines the sink. An async sink observes events
 * in emit order but cannot delay them; ordering between its own pending
 * handlers is its own responsibility.
 */
export type RunEventSink = (event: RunEvent) => void | Promise<void>;

/** Strips the live target from a result, keeping its stable identity. */
export function toEventResult(record: ResultRecord): RunEventResult {
  return {
    ...encodeResult(record),
    target: { name: record.target.name, platform: record.target.platform },
  };
}

/**
 * Builds the run's single event writer over every configured sink. Sinks are
 * quarantined independently, so a broken host callback cannot silence the
 * list reporter or vice versa. Returns a no-op when no sink is configured,
 * so call sites never branch.
 */
export function createRunEventEmitter(
  sinks: readonly (RunEventSink | undefined)[],
): (fact: RunEventFact) => void {
  const active = sinks.filter((sink) => sink !== undefined);
  if (active.length === 0) return () => undefined;
  let seq = 0;
  const quarantined = new Set<RunEventSink>();
  return (fact) => {
    seq += 1;
    const event: RunEvent = { seq, at: timestamp(), ...fact };
    for (const sink of active) {
      if (quarantined.has(sink)) continue;
      try {
        const result = sink(event);
        // An async sink's rejection must neither surface as an unhandled
        // rejection nor keep the sink subscribed.
        if (result instanceof Promise) result.catch(() => quarantined.add(sink));
      } catch {
        quarantined.add(sink);
      }
    }
  };
}
