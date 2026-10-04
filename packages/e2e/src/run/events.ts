/**
 * Structured run events: the run's single event spine.
 *
 * Every event is plain JSON data — the same records the report persists and
 * the worker IPC already carries, so a sink can forward them over any wire
 * without touching live handles. The list reporter consumes exactly this
 * stream (`ListReporter.handle`, report/list.ts), so no two consumers can
 * drift: there is one dispatch, not two. The report stays the canonical
 * record; the stream exists so consumers can render progress while the run
 * is still going.
 *
 * The emitter is the single writer: it stamps `seq` and `at`, so ordering
 * survives any transport that preserves per-connection order. A sink that
 * throws is quarantined for the rest of the run; a sink whose returned
 * promise rejects is quarantined once the rejection settles, so events
 * emitted before then may still reach it. Either way the quarantine is one
 * stderr line naming the sink and the event, and a broken consumer can never
 * fail the run.
 */

import type { ExploreProgress } from '../explore/progress.ts';
import { errorMessage, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { encodeResult, type ResultRecord, type SerialGroupRecord, type WireResultRecord } from './records.ts';
import type { StepProgress } from './steps.ts';

/** The closed set of process exit codes a run can end with. */
export type RunExitCode = 0 | 1 | 2 | 3 | 4 | 130;

/**
 * The run's status as the report records it. `blocked` is derived from the
 * results: the run did not pass and every non-passing result carries a
 * blockable code, so nothing says the product misbehaved. The outcome, the
 * `run-finished` event, and `report.json` carry the same value.
 */
export type RunStatus = 'passed' | 'failed' | 'blocked' | 'error' | 'interrupted';

/**
 * `ResultRecord` minus the live resolved target (the wire encoding the worker
 * IPC already uses), plus the target's stable identity so a consumer can
 * attribute the result without a side lookup.
 */
export interface RunEventResult extends WireResultRecord {
  readonly target: { readonly name: string; readonly platform: string };
}

/**
 * What one setup step is about. `collect` loads the test files; `prepare` is
 * one target's engine provisioning (a first-run browser download); `service`
 * and `app` are the processes the run owns, labelled the way the runner names
 * them (`service "postgres"`, `target "web" command`).
 */
export type SetupStep =
  | { readonly kind: 'collect' }
  | { readonly kind: 'prepare'; readonly target: string; readonly engine: string }
  | { readonly kind: 'service'; readonly label: string }
  | { readonly kind: 'app'; readonly label: string };

/** One fact about the run; the emitter wraps it in the envelope. */
export type RunEventFact =
  | {
      readonly type: 'run-started';
      readonly runId: string;
      readonly projectId: string;
      readonly projectRoot: string;
      /** Absolute directory the report's artifact paths are relative to. */
      readonly artifactsRoot: string;
      readonly ci: boolean;
      readonly targets: readonly string[];
      /**
       * The configured agents unpinned tests run as, when they are not
       * `default` alone: `--agent` named them, one result per test each.
       */
      readonly agents?: readonly string[];
      /**
       * The run agent's model as the AI SDK instance's `provider/model-id`;
       * absent when none is configured or the run names several agents.
       */
      readonly model?: string;
      /**
       * The run agent's judge, the model its judgments use, in the same
       * form; absent when judgments use `model`.
       */
      readonly judge?: string;
    }
  | {
      /**
       * What the run will execute, emitted once collection, selection, and
       * every target's `prepare` are done: from here the run executes, so
       * this event's `at` is the run's start (the report's `startedAt`, the
       * list reporter's `Start at`), and a first-run download narrated
       * before it is not on the clock. `total` counts every test-target
       * pair, including unselected ones; `files` breaks the reportable pairs
       * (run or explicitly skipped) down per test file and target, so a
       * reporter can tell when a file's results are complete without a side
       * lookup.
       */
      readonly type: 'plan';
      readonly total: number;
      readonly files: readonly {
        readonly file: string;
        readonly target: string;
        readonly tests: number;
      }[];
    }
  | {
      /**
       * One line of run-level progress outside any test: a first-run
       * download narrating under a `prepare` step, a reused app process
       * under an `app` step, or what a worker's engine `init` reported
       * (`<target> worker <slot>: <line>`) once the run is executing.
       * `target` is the target the line is about, `app` for the app
       * process and its services, `collect` for a test file a narrowed
       * run skipped, or `run` for a recording the run asked for and will
       * not make.
       */
      readonly type: 'notice';
      readonly target: string;
      readonly message: string;
    }
  | {
      /**
       * Text a test wrote to stdout or stderr (`console.log` and friends),
       * as one write of a worker process on `target`. `pair` is the test
       * executing at the time, or undefined for output between tests (a
       * module's top level while its file loads). Reporters print it above
       * the live window; the runner never lets it reach the terminal itself.
       */
      readonly type: 'output';
      readonly target: string;
      readonly pair: { readonly testId: string; readonly agent: string; readonly repeat: number } | undefined;
      readonly stream: 'stdout' | 'stderr';
      readonly text: string;
    }
  | {
      /**
       * One step of the run's setup, before any test: `started` as it begins,
       * `finished` once it is done, with how long it took. Collection and each
       * target's engine `prepare` come before `plan`; the services and app
       * commands start after it. A step that fails ends as a `run-error`
       * instead, and a step the interrupt cuts short reports nothing more.
       */
      readonly type: 'setup';
      readonly step: SetupStep;
      readonly state: 'started';
    }
  | {
      readonly type: 'setup';
      readonly step: SetupStep;
      readonly state: 'finished';
      readonly durationMs: number;
      /** `reused` when a service or app command attached to a process already serving its URL instead of spawning. */
      readonly outcome?: 'reused';
    }
  | {
      readonly type: 'test-started';
      readonly testId: string;
      /** The configured agent the test runs as; a test run as several starts once per agent. */
      readonly agent: string;
      /** Which run of the test this is under `--repeat-each`, 0 for the first; each repeat starts once. */
      readonly repeat: number;
      readonly title: string;
      /** Project-root-relative test file, so reporters can group by file. */
      readonly file: string;
      /**
       * The test's serial group, when it belongs to one. Members are announced
       * one at a time as they begin; the previous member is done executing by
       * then, though every member's result arrives once the group completes.
       */
      readonly serialId: string | undefined;
      readonly target: string;
    }
  | {
      readonly type: 'step';
      readonly testId: string;
      readonly agent: string;
      readonly repeat: number;
      readonly target: string;
      readonly progress: StepProgress;
    }
  | { readonly type: 'test-finished'; readonly result: RunEventResult }
  | {
      /**
       * A finished serial group, emitted before its members' `test-finished`
       * results. Member results carry `serialGroupId` and no attempts of their
       * own: their steps, durations, and errors live in the group record.
       */
      readonly type: 'serial-group';
      readonly group: SerialGroupRecord;
    }
  | {
      /**
       * One moment of an `e2e explore` run: the exploration starting as its
       * test does, the planner deciding, a step opening or closing, a finding
       * the instant it is reported, and the closing assessment. Absent from
       * `e2e run`; the record is `run.explore` in the report.
       */
      readonly type: 'explore';
      readonly progress: ExploreProgress;
    }
  | { readonly type: 'run-error'; readonly error: SerializedError }
  | {
      /**
       * An interrupt landed. `graceful`: the running test is interrupted and
       * its teardown runs. `forced` (a second interrupt): every worker tears
       * its engine down at once and is killed after the cleanup budget.
       */
      readonly type: 'run-interrupted';
      readonly mode: 'graceful' | 'forced';
    }
  | {
      /**
       * The run reached its failure limit (`--max-failures`): nothing more
       * is dispatched, the tests running end as interrupted, and the tests
       * not started are skipped with cause `failure-limit`. The exit code is
       * the failures' own, not an interrupt's.
       */
      readonly type: 'run-stopped';
      readonly failures: number;
      readonly limit: number;
    }
  | {
      readonly type: 'run-finished';
      readonly status: RunStatus;
      readonly exitCode: RunExitCode;
      readonly reportPath?: string;
      /** Where `--ai-trace` wrote the run's model calls, once the file exists. */
      readonly aiTracePath?: string;
      /**
       * The failure page written for each test that failed, timed out, or was
       * flaky, by report result id, as a path from the project root.
       */
      readonly failurePages?: Readonly<Record<string, string>>;
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

/** A sink with the label the stderr line names should it be quarantined. */
interface RunEventSubscriber {
  readonly name: string;
  readonly onEvent: RunEventSink;
}

/** Strips the live target from a result, keeping its stable identity. */
export function toEventResult(record: ResultRecord): RunEventResult {
  return {
    ...encodeResult(record),
    target: { name: record.target.name, platform: record.target.platform },
  };
}

/**
 * Builds the run's single event writer over every configured sink. Sinks are
 * quarantined independently, so one broken sink cannot silence the
 * list reporter or vice versa, and each quarantine is one stderr line naming
 * the sink, the event, and the error. Returns a no-op when no sink is
 * configured, so call sites never branch.
 */
export function createRunEventEmitter(
  subscribers: readonly (RunEventSubscriber | undefined)[],
): (fact: RunEventFact) => void {
  const active = subscribers.filter((subscriber) => subscriber !== undefined);
  if (active.length === 0) return () => undefined;
  let seq = 0;
  const quarantined = new Set<RunEventSubscriber>();
  const quarantine = (subscriber: RunEventSubscriber, event: RunEvent, cause: unknown): void => {
    // Several pending promises of one sink may reject; the first names it, the rest are already quarantined.
    if (quarantined.has(subscriber)) return;
    quarantined.add(subscriber);
    process.stderr.write(
      `e2e: reporter "${subscriber.name}" threw on ${event.type}: ${errorMessage(cause)}; ignoring it for the rest of the run\n`,
    );
  };
  return (fact) => {
    seq += 1;
    const event: RunEvent = { seq, at: timestamp(), ...fact };
    for (const subscriber of active) {
      if (quarantined.has(subscriber)) continue;
      try {
        const result = subscriber.onEvent(event);
        // An async sink's rejection must neither surface as an unhandled
        // rejection nor keep the sink subscribed.
        if (result instanceof Promise) result.catch((cause: unknown) => quarantine(subscriber, event, cause));
      } catch (cause) {
        quarantine(subscriber, event, cause);
      }
    }
  };
}
