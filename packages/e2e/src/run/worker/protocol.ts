/**
 * Protocol between the scheduler and one target worker. Every message is
 * JSON-serializable so the same shapes work over a child-process IPC channel
 * and in-process (see `run/unit-runner.ts`). Two things deliberately never
 * cross: `ResolvedTarget`, which may hold a live engine handle, and test
 * functions. Work units therefore carry `TestIdentity` and the worker pairs
 * each identity with a locally resolved test function.
 */

import type { TestIdentity } from '../../collect/collect.ts';
import type { ResolvedTestOptions, SkipInfo } from '../../collect/select.ts';
import type { CliOverrides, PortAssignments, ResolvedTarget } from '../../config/resolve.ts';
import type { AiTraceSnapshot } from '../../internal/ai-trace.ts';
import type { DebugSnapshot } from '../../internal/debug.ts';
import type { SerializedError } from '../../internal/errors.ts';
import type { AttemptRecord, ResultRecord, RunError, SerialGroupRecord, SerialMemberRecord, WireResultRecord } from '../records.ts';
import type { SerialAttemptRun, SerialAttemptStart } from '../serial.ts';
import type { StepProgress } from '../steps.ts';

/** One runnable pair on the wire; the worker resolves the test function. */
export interface WirePair {
  readonly test: TestIdentity;
  /** The configured agent this pair runs as; one test may appear once per agent. */
  readonly agent: string;
  /** Which run of the test this is under `--repeat-each`, 0 for the first; one test may appear once per repeat. */
  readonly repeat: number;
  readonly options: ResolvedTestOptions;
}

/**
 * Bootstrap payload for a child-process worker. Transport-private: the
 * scheduler never builds one, because run-wide settings are closed over by the
 * spawn factory rather than sent as a message.
 */
export interface WorkerBootstrapMessage {
  readonly type: 'bootstrap';
  readonly bootstrap: WorkerBootstrap;
}

/** Everything a child-process worker can receive. */
export type ChildProcessInbound = WorkerBootstrapMessage | MainToWorker;

export interface WorkerBootstrap {
  readonly configPath: string;
  readonly projectRoot: string;
  readonly configDigest: string;
  /**
   * The runner's command-line overrides. A worker re-resolves the config from
   * the same file, so without these it would silently disagree with the runner
   * about anything a flag changed — `--retries` among them. The config digest covers only the file, so the mismatch check cannot
   * catch it.
   */
  readonly cli: CliOverrides;
  /**
   * The free ports the runner assigned to app URLs declared with port 0, by
   * target name. Chosen once in the runner and outside the digest, so a
   * worker must be told them to resolve the same URLs.
   */
  readonly ports: PortAssignments;
  readonly targetName: string;
  /** This worker's slot among the target's workers; see `EngineInitInfo.workerSlot`. */
  readonly workerSlot: number;
  readonly runId: string;
  readonly artifactsRoot: string;
  /** See `TargetExecutorOptions.rerunDir`. */
  readonly rerunDir: string | undefined;
  readonly headed: boolean;
  readonly sessionsRoot: string;
  /** Per-run AES key; transferred only over this channel, never disk or env. */
  readonly sessionKeyBase64: string;
  /** Whether the worker should collect `--debug` phase timings. */
  readonly debug: boolean;
  /** Whether the worker should record model calls for `--ai-trace`. */
  readonly aiTrace: boolean;
}

export interface RunUnitMessage {
  readonly type: 'run-unit';
  readonly unitId: string;
  readonly kind: 'setup' | 'file';
  readonly file: string;
  readonly absolutePath: string;
  readonly pairs: readonly WirePair[];
  /**
   * The run's `--max-failures` and the failures it had counted when the unit
   * was dispatched. The worker stops starting the unit's tests once its own
   * failures reach the limit, without waiting for the runner's interrupt to
   * arrive: by then it could have started the next test in the file.
   */
  readonly failureLimit?: FailureLimit;
}

/** A run's failure limit and the failures counted toward it so far. */
export interface FailureLimit {
  readonly limit: number;
  readonly failures: number;
}

export interface InterruptMessage {
  readonly type: 'interrupt';
  /**
   * What the pairs the worker has not started yet are skipped as, when the
   * interrupt has a reason of its own (the run's failure limit); absent for a
   * plain interrupt.
   */
  readonly skip?: SkipInfo;
}

export interface ShutdownMessage {
  readonly type: 'shutdown';
}

/**
 * A forced interrupt: dispose the engine now, beside whatever the running
 * unit is still doing, and exit. The runner kills the worker once the cleanup
 * budget is spent, so the engine gets exactly one bounded chance to let go.
 */
export interface TerminateMessage {
  readonly type: 'terminate';
}

/**
 * Asks the worker to answer with `pong` from its event loop. The scheduler
 * sends it only once an attempt is past its test timeout, to tell a worker
 * still tearing the attempt down from one whose event loop is blocked.
 */
export interface PingMessage {
  readonly type: 'ping';
}

export type MainToWorker = RunUnitMessage | InterruptMessage | ShutdownMessage | TerminateMessage | PingMessage;

export interface ReadyMessage {
  readonly type: 'ready';
}

/** One pair about to execute, as reporters see it. */
export interface PairStart {
  readonly testId: string;
  /** The configured agent the pair runs as; with the test id and the repeat, the pair's identity. */
  readonly agent: string;
  /** Which run of the test this is under `--repeat-each`, 0 for the first. */
  readonly repeat: number;
  /** Joined title path, so reporters need no side lookup by test ID. */
  readonly title: string;
  /** Project-root-relative test file. */
  readonly file: string;
  /**
   * The pair's serial group, when it belongs to one. A serial unit announces
   * its members one at a time and the previous member has finished executing
   * when the next starts, though every member's result arrives together once
   * the group completes.
   */
  readonly serialId: string | undefined;
}

export interface PairStartMessage extends PairStart {
  readonly type: 'pair-start';
}

/** Live step progress of the running attempt; plain data, fire-and-forget. */
export interface ProgressMessage {
  readonly type: 'progress';
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  readonly progress: StepProgress;
}

/**
 * Text a test wrote to the worker's stdout or stderr (`console.log` and
 * friends). The worker's streams are the runner's terminal, where a stray
 * line would land inside the live window, so the worker captures them and
 * the reporter prints each line above it, attributed to `pair` when one is
 * executing.
 */
export interface OutputMessage {
  readonly type: 'output';
  readonly pair: { readonly testId: string; readonly agent: string; readonly repeat: number } | undefined;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/**
 * One line the engine's `init` reported through `info.log`. Fire-and-forget
 * like `progress`: a line the worker sends after its channel closed is lost.
 */
export interface NoticeMessage {
  readonly type: 'notice';
  readonly message: string;
}

/**
 * An attempt's test timeout started: its `beforeEach` hooks and body run
 * now. The worker enforces the timeout with its own timers, which a body
 * that blocks the event loop never lets fire, so the scheduler keeps the
 * deadline too; see `SchedulerWorker.watch`.
 */
export interface AttemptDeadlineMessage {
  readonly type: 'attempt-deadline';
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  /** The attempt's index among the pair's attempts. */
  readonly attempt: number;
  /** The test's resolved `timeout`. */
  readonly timeoutMs: number;
  /** How long past the timeout the worker may go without answering a `ping`: the cleanup budget. */
  readonly graceMs: number;
}

/** The attempt the last `attempt-deadline` announced has ended, verdict and cleanup included. */
export interface AttemptEndMessage {
  readonly type: 'attempt-end';
}

/** The answer to `ping`. */
export interface PongMessage {
  readonly type: 'pong';
}

export interface ResultMessage {
  readonly type: 'result';
  readonly result: WireResultRecord;
}

export interface SerialGroupMessage {
  readonly type: 'serial-group';
  readonly group: SerialGroupRecord;
}

/**
 * An attempt of an ordinary or setup pair begins, its realm and `beforeAll`
 * hooks included. With `attempt`, it tells a crash during an attempt from
 * one between attempts (an `afterAll` after the last one): only the first
 * is charged a new attempt, with this index.
 */
export interface AttemptStartMessage {
  readonly type: 'attempt-start';
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  readonly index: number;
}

/**
 * One finished attempt of an ordinary or setup pair. A pair's result waits
 * for its last attempt, so each attempt also goes out as it ends: a worker
 * that dies during a retry must not take the attempts before it along. The
 * result still carries every attempt; the scheduler keeps these only until
 * it arrives.
 */
export interface AttemptMessage {
  readonly type: 'attempt';
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  readonly attempt: AttemptRecord;
}

/** One member that finished in the serial group attempt running now; see `AttemptMessage`. */
export interface SerialMemberMessage {
  readonly type: 'serial-member';
  /** The group's report id (`SerialGroupRecord.id`). */
  readonly groupId: string;
  readonly attempt: SerialAttemptStart;
  readonly member: SerialMemberRecord;
}

/** One finished serial group attempt; see `AttemptMessage`. */
export interface SerialAttemptMessage {
  readonly type: 'serial-attempt';
  /** The group's report id (`SerialGroupRecord.id`). */
  readonly groupId: string;
  readonly run: SerialAttemptRun;
}

export interface UnitDoneMessage {
  readonly type: 'unit-done';
  readonly unitId: string;
  readonly runErrors: readonly RunError[];
  /** Phase timings drained from this worker since the previous unit. */
  readonly debug?: DebugSnapshot;
  /** Model calls drained from this worker since the previous unit. */
  readonly aiTrace?: AiTraceSnapshot;
}

/**
 * The worker's last word before it exits: engine disposal happens after the
 * final unit drained its errors, so its outcome rides here.
 */
export interface ShutdownDoneMessage {
  readonly type: 'shutdown-done';
  readonly runErrors: readonly RunError[];
  /** Phase timings drained from this worker since the last unit. */
  readonly debug?: DebugSnapshot;
  /** Model calls drained from this worker since the last unit, open ones included. */
  readonly aiTrace?: AiTraceSnapshot;
}

export interface FatalMessage {
  readonly type: 'fatal';
  readonly error: SerializedError;
}

/**
 * The worker met a run-level configuration failure (an unusable model on
 * the first `agent` acquisition) and asks the run to stop. The worker stays
 * alive to finish reporting its unit as interrupted.
 */
export interface RunAbortMessage {
  readonly type: 'run-abort';
  readonly error: SerializedError;
}

export type WorkerToMain =
  | ReadyMessage
  | PairStartMessage
  | ProgressMessage
  | AttemptDeadlineMessage
  | AttemptEndMessage
  | PongMessage
  | OutputMessage
  | NoticeMessage
  | ResultMessage
  | SerialGroupMessage
  | AttemptStartMessage
  | AttemptMessage
  | SerialMemberMessage
  | SerialAttemptMessage
  | UnitDoneMessage
  | ShutdownDoneMessage
  | FatalMessage
  | RunAbortMessage;

/** Reattaches the scheduler's resolved target to a wire result. */
export function decodeResult(wire: WireResultRecord, target: ResolvedTarget): ResultRecord {
  return { ...wire, target };
}
