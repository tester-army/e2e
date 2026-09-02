/**
 * The run engine: dispatches file-target work units across workers (spec
 * 11-lifecycle.md). Per target, setup units complete before ordinary units
 * dispatch; a worker is bound to one target, runs one unit at a time, and is
 * discarded after any failing unit or infrastructure fault.
 *
 * Workers are reached only through `SpawnUnitRunner`, so the same scheduling,
 * gating, and reporting logic covers both child-process and in-process
 * execution.
 */

import type { Collection } from '../collect/collect.ts';
import type { Selection, TestTargetPair } from '../collect/select.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { AiTraceSnapshot } from '../internal/ai-trace.ts';
import type { DebugSnapshot } from '../internal/debug.ts';
import { InfrastructureError, serializeError } from '../internal/errors.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.ts';
import type { StepProgress } from './steps.ts';
import type { SpawnUnitRunner, UnitRunner } from './unit-runner.ts';
import {
  buildWorkPlans,
  INTERRUPTED_BEFORE_START,
  nonRunResult,
  pairResult,
  setupFailedSkip,
  unstartedResult,
  type WorkUnit,
} from './units.ts';
import { decodeResult, type WirePair, type WorkerToMain } from './worker/protocol.ts';

export interface SchedulerEvents {
  onResult(result: ResultRecord): void;
  onSerialGroup(group: SerialGroupRecord): void;
  onRunError(error: RunError): void;
  /** A worker began executing one test-target pair. */
  onTestStart?(testId: string, title: string, targetName: string): void;
  /** Live step progress of one running attempt. */
  onProgress?(testId: string, targetName: string, progress: StepProgress): void;
  /** Phase timings a child-process worker drained after one unit. */
  onDebug?(snapshot: DebugSnapshot): void;
  /** Model calls a child-process worker drained after one unit. */
  onAiTrace?(snapshot: AiTraceSnapshot): void;
}

export interface RunUnitsOptions {
  readonly selection: Selection;
  readonly collection: Collection;
  readonly projectRoot: string;
  /** Maximum workers alive at once across all targets. */
  readonly workers: number;
  /** Budget for a worker to finish an in-flight unit after an interrupt. */
  readonly interruptGraceMs: number;
  readonly interruptSignal: AbortSignal;
  readonly spawn: SpawnUnitRunner;
  readonly events: SchedulerEvents;
}

/** Consecutive worker-boot failures per target before its units are failed. */
const MAX_INIT_FAILURES = 2;

/** How long a retiring or draining worker gets before it is force-killed. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Runs every selected unit and streams records. */
export async function runUnits(options: RunUnitsOptions): Promise<void> {
  await new Scheduler(options).run();
}

interface TargetState {
  readonly target: ResolvedTarget;
  readonly setupQueue: WorkUnit[];
  readonly fileQueue: WorkUnit[];
  /** session name -> id of the setup test that failed to produce it */
  readonly failedSessions: Map<string, string>;
  initFailures: number;
  failed: boolean;
}

/**
 * One worker and the unit it is executing. Owns its own lifecycle so the
 * scheduler never has to keep a separate record in sync with the transport.
 */
class SchedulerWorker {
  readonly runner: UnitRunner;
  state: 'starting' | 'idle' | 'busy' | 'retired' = 'starting';
  /** Unit handed over but not yet acknowledged, while the worker starts up. */
  queued: WorkUnit | undefined;
  unit: WorkUnit | undefined;
  /** Test ids already reported for `unit`, used to synthesize crash results. */
  readonly reported = new Set<string>();
  inFlightTestId: string | undefined;
  sawFailure = false;
  becameReady = false;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly targetName: string,
    spawn: SpawnUnitRunner,
    onMessage: (worker: SchedulerWorker, message: WorkerToMain) => void,
    onExit: (worker: SchedulerWorker, detail: string) => void,
  ) {
    this.runner = spawn(targetName, {
      onMessage: (message) => onMessage(this, message),
      onExit: (detail) => {
        this.clearKillTimer();
        onExit(this, detail);
      },
    });
  }

  /** Sends a unit and starts tracking it. */
  dispatch(unit: WorkUnit): void {
    this.state = 'busy';
    this.unit = unit;
    this.reported.clear();
    this.inFlightTestId = undefined;
    this.sawFailure = false;
    const pairs: WirePair[] = unit.pairs.map((pair) => ({
      test: pair.test,
      options: pair.options,
    }));
    this.runner.send({
      type: 'run-unit',
      unitId: unit.id,
      kind: unit.kind,
      file: unit.file,
      absolutePath: unit.absolutePath,
      pairs,
    });
  }

  /** Asks for a graceful exit and force-kills if it takes too long. */
  shutdown(graceMs: number): void {
    this.runner.send({ type: 'shutdown' });
    this.killAfter(graceMs);
  }

  killAfter(graceMs: number): void {
    if (this.killTimer !== undefined || !this.runner.alive) return;
    this.killTimer = setTimeout(() => this.runner.kill(), graceMs);
    this.killTimer.unref();
  }

  clearKillTimer(): void {
    if (this.killTimer === undefined) return;
    clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }
}

class Scheduler {
  private readonly targets = new Map<string, TargetState>();
  /** Every worker that has not exited yet, retired ones included. */
  private readonly workers: SchedulerWorker[] = [];
  private wake: (() => void) | undefined;
  private interruptBroadcast = false;

  constructor(private readonly options: RunUnitsOptions) {}

  async run(): Promise<void> {
    const plans = buildWorkPlans(
      this.options.selection,
      this.options.collection,
      this.options.projectRoot,
    );
    for (const plan of plans) {
      this.targets.set(plan.target.name, {
        target: plan.target,
        setupQueue: [...plan.setupUnits],
        fileQueue: [...plan.fileUnits],
        failedSessions: new Map(),
        initFailures: 0,
        failed: false,
      });
      if (!this.options.interruptSignal.aborted) {
        for (const pair of plan.immediate) this.options.events.onResult(nonRunResult(pair));
      }
    }

    const onInterrupt = (): void => this.wakeUp();
    this.options.interruptSignal.addEventListener('abort', onInterrupt, { once: true });
    try {
      for (;;) {
        this.broadcastInterrupt();
        this.dispatch();
        if (this.isDone()) break;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      this.options.interruptSignal.removeEventListener('abort', onInterrupt);
      await this.drain();
    }
  }

  private wakeUp(): void {
    const resolve = this.wake;
    this.wake = undefined;
    resolve?.();
  }

  private broadcastInterrupt(): void {
    if (!this.options.interruptSignal.aborted || this.interruptBroadcast) return;
    this.interruptBroadcast = true;
    for (const state of this.targets.values()) {
      state.setupQueue.length = 0;
      state.fileQueue.length = 0;
    }
    // Snapshot first: retiring a worker mutates `this.workers`, and iterating
    // the live array would skip entries as they are spliced out.
    const live = [...this.workers];
    for (const worker of live) {
      worker.runner.send({ type: 'interrupt' });
      if (worker.state === 'busy') worker.killAfter(this.options.interruptGraceMs);
      else this.retire(worker);
    }
  }

  private isDone(): boolean {
    for (const state of this.targets.values()) {
      if (state.setupQueue.length > 0 || state.fileQueue.length > 0) return false;
    }
    return !this.workers.some(
      (worker) => worker.state === 'busy' || worker.queued !== undefined,
    );
  }

  // --- dispatch ---

  /**
   * Assigns as much work as capacity allows. A unit is always taken off its
   * queue before a worker is acquired, so a spawn can never be left with
   * nothing to do.
   */
  private dispatch(): void {
    if (this.options.interruptSignal.aborted) return;
    for (;;) {
      const state = this.nextTarget();
      if (state === undefined) return;
      const unit = this.takeUnit(state);
      if (unit === undefined) continue;
      const worker = this.acquireWorker(state.target.name);
      if (worker === undefined) {
        // No capacity right now; put the unit back at the head of its queue.
        this.returnUnit(state, unit);
        return;
      }
      if (worker.state === 'idle') worker.dispatch(unit);
      else worker.queued = unit;
    }
  }

  /** The first target that has a dispatchable unit and could accept a worker. */
  private nextTarget(): TargetState | undefined {
    for (const state of this.targets.values()) {
      if (this.peekUnit(state) === undefined) continue;
      if (this.canPlaceWork(state.target.name)) return state;
    }
    return undefined;
  }

  private peekUnit(state: TargetState): WorkUnit | undefined {
    if (state.failed) return undefined;
    if (state.setupQueue.length > 0) return state.setupQueue[0];
    // Ordinary units wait until every setup for this target has finished.
    if (this.hasPendingSetup(state)) return undefined;
    return state.fileQueue[0];
  }

  /**
   * Setup gating is derived, not counted: a target has pending setups while
   * any setup unit is queued or in flight for it.
   */
  private hasPendingSetup(state: TargetState): boolean {
    if (state.setupQueue.length > 0) return true;
    return this.workers.some(
      (worker) =>
        worker.targetName === state.target.name &&
        (worker.unit?.kind === 'setup' || worker.queued?.kind === 'setup'),
    );
  }

  /** Pops the next unit, applying setup-failure gating; may complete it inline. */
  private takeUnit(state: TargetState): WorkUnit | undefined {
    for (;;) {
      const unit = this.peekUnit(state);
      if (unit === undefined) return undefined;
      if (unit.kind === 'setup') state.setupQueue.shift();
      else state.fileQueue.shift();

      const runnable = unit.pairs.filter((pair) => {
        const skip = this.dependencySkip(state, pair);
        if (skip === undefined) return true;
        this.options.events.onResult(
          pairResult(pair, { status: 'skipped', selected: true, skip, attempts: [] }),
        );
        return false;
      });
      if (runnable.length === 0) continue;
      return runnable.length === unit.pairs.length ? unit : { ...unit, pairs: runnable };
    }
  }

  /** Puts an untaken unit back so capacity pressure never drops work. */
  private returnUnit(state: TargetState, unit: WorkUnit): void {
    if (unit.kind === 'setup') state.setupQueue.unshift(unit);
    else state.fileQueue.unshift(unit);
  }

  /** Skip info when a pair's session was not produced by a passing setup. */
  private dependencySkip(
    state: TargetState,
    pair: TestTargetPair,
  ): ReturnType<typeof setupFailedSkip> | undefined {
    const session = pair.options.session;
    if (session === undefined) return undefined;
    const failedSetup = state.failedSessions.get(session);
    if (failedSetup === undefined) return undefined;
    return setupFailedSkip(session, failedSetup);
  }

  // --- workers ---

  /** Whether a worker for `targetName` can be obtained without exceeding the cap. */
  private canPlaceWork(targetName: string): boolean {
    if (this.findAvailable(targetName) !== undefined) return true;
    if (this.workers.length < this.options.workers) return true;
    return this.findRetirableForeignWorker(targetName) !== undefined;
  }

  /**
   * A worker for this target, spawning one if the cap allows. Retired workers
   * keep counting against the cap until they are gone, so a discarded worker
   * never doubles the number of live surfaces. At capacity this discards an
   * idle worker bound to another target and returns nothing; its exit wakes
   * the loop and dispatch retries with the freed slot.
   */
  private acquireWorker(targetName: string): SchedulerWorker | undefined {
    const available = this.findAvailable(targetName);
    if (available !== undefined) return available;
    if (this.workers.length < this.options.workers) return this.spawn(targetName);
    const foreign = this.findRetirableForeignWorker(targetName);
    if (foreign !== undefined) this.retire(foreign);
    return undefined;
  }

  private findAvailable(targetName: string): SchedulerWorker | undefined {
    return this.workers.find(
      (worker) =>
        worker.targetName === targetName &&
        worker.queued === undefined &&
        (worker.state === 'idle' || worker.state === 'starting'),
    );
  }

  private findRetirableForeignWorker(targetName: string): SchedulerWorker | undefined {
    return this.workers.find(
      (worker) => worker.state === 'idle' && worker.targetName !== targetName,
    );
  }

  private spawn(targetName: string): SchedulerWorker {
    const worker = new SchedulerWorker(
      targetName,
      this.options.spawn,
      (target, message) => this.onMessage(target, message),
      (target, detail) => this.onExit(target, detail),
    );
    this.workers.push(worker);
    return worker;
  }

  /**
   * Discards a worker. It stays in `this.workers` (so it keeps counting
   * against the cap) until its exit is observed.
   */
  private retire(worker: SchedulerWorker): void {
    if (worker.state === 'retired') return;
    worker.state = 'retired';
    // Dropping rather than requeueing is only safe because the sole caller
    // that can retire a worker still holding a unit is the interrupt
    // broadcast, which clears the queues anyway. Requeueing here would strand
    // the loop instead: `dispatch` stops once interrupted, so the unit would
    // sit in a queue that `isDone` waits on forever. The other callers only
    // ever retire idle workers, which never hold a queued unit.
    worker.queued = undefined;
    worker.shutdown(SHUTDOWN_GRACE_MS);
  }

  private forget(worker: SchedulerWorker): void {
    const index = this.workers.indexOf(worker);
    if (index !== -1) this.workers.splice(index, 1);
  }

  private targetState(worker: SchedulerWorker): TargetState {
    const state = this.targets.get(worker.targetName);
    if (state === undefined) {
      throw new Error(`worker bound to unknown target "${worker.targetName}"`);
    }
    return state;
  }

  private onMessage(worker: SchedulerWorker, message: WorkerToMain): void {
    switch (message.type) {
      case 'ready': {
        worker.becameReady = true;
        this.targetState(worker).initFailures = 0;
        worker.state = 'idle';
        const queued = worker.queued;
        worker.queued = undefined;
        if (queued !== undefined) worker.dispatch(queued);
        this.wakeUp();
        break;
      }
      case 'pair-start': {
        worker.inFlightTestId = message.testId;
        this.options.events.onTestStart?.(message.testId, message.title, worker.targetName);
        break;
      }
      case 'progress': {
        this.options.events.onProgress?.(message.testId, worker.targetName, message.progress);
        break;
      }
      case 'result': {
        const state = this.targetState(worker);
        const result = decodeResult(message.result, state.target);
        worker.reported.add(result.test.id);
        if (result.status !== 'passed' && result.status !== 'flaky' && result.status !== 'skipped') {
          worker.sawFailure = true;
        }
        if (result.test.kind === 'setup') this.recordSetupOutcome(state, result);
        this.options.events.onResult(result);
        break;
      }
      case 'serial-group': {
        this.options.events.onSerialGroup(message.group);
        break;
      }
      case 'unit-done': {
        for (const runError of message.runErrors) this.options.events.onRunError(runError);
        if (message.debug !== undefined) this.options.events.onDebug?.(message.debug);
        if (message.aiTrace !== undefined) this.options.events.onAiTrace?.(message.aiTrace);
        const unit = worker.unit;
        worker.unit = undefined;
        worker.inFlightTestId = undefined;
        if (unit !== undefined && unit.id !== message.unitId) {
          this.options.events.onRunError({
            error: serializeError(
              new InfrastructureError(
                'WORKER_PROTOCOL',
                `worker reported unit "${message.unitId}" while running "${unit.id}"`,
              ),
            ),
          });
        }
        if (worker.state !== 'retired') {
          // Spec 11-lifecycle.md: discard the worker after a failing unit.
          if (worker.sawFailure) this.retire(worker);
          else worker.state = 'idle';
        }
        this.wakeUp();
        break;
      }
      case 'shutdown-done': {
        for (const runError of message.runErrors) this.options.events.onRunError(runError);
        if (message.debug !== undefined) this.options.events.onDebug?.(message.debug);
        if (message.aiTrace !== undefined) this.options.events.onAiTrace?.(message.aiTrace);
        break;
      }
      case 'fatal': {
        this.options.events.onRunError({ error: message.error });
        worker.runner.kill();
        break;
      }
    }
  }

  private recordSetupOutcome(state: TargetState, result: ResultRecord): void {
    if (result.status === 'passed' || result.status === 'flaky') return;
    for (const session of result.test.sessions) {
      state.failedSessions.set(session, result.test.id);
    }
  }

  private onExit(worker: SchedulerWorker, detail: string): void {
    const tracked = this.workers.includes(worker);
    this.forget(worker);
    const state = this.targetState(worker);
    const unit = worker.unit;
    worker.unit = undefined;

    // A queued unit never reached the worker. Requeue it before any handling
    // below, so that failing the target drains it along with the rest.
    if (worker.queued !== undefined) {
      this.returnUnit(state, worker.queued);
      worker.queued = undefined;
    }

    if (unit !== undefined) {
      this.options.events.onRunError({
        error: serializeError(
          new InfrastructureError(
            'WORKER_EXIT',
            `worker for target "${worker.targetName}" exited unexpectedly (${detail}) during ${unit.id}`,
          ),
        ),
      });
      this.synthesizeCrashResults(state, worker, unit);
    } else if (tracked && !worker.becameReady) {
      state.initFailures += 1;
      if (state.initFailures >= MAX_INIT_FAILURES) this.failTarget(state);
    }
    this.wakeUp();
  }

  /** Emits records for a unit whose worker died before reporting it done. */
  private synthesizeCrashResults(
    state: TargetState,
    worker: SchedulerWorker,
    unit: WorkUnit,
  ): void {
    const interrupted = this.options.interruptSignal.aborted;
    for (const pair of unit.pairs) {
      if (worker.reported.has(pair.test.id)) continue;
      if (interrupted) {
        this.options.events.onResult(unstartedResult(pair, INTERRUPTED_BEFORE_START));
        continue;
      }
      // A crashed setup never persisted its sessions; dependents must skip.
      if (pair.test.kind === 'setup') {
        for (const session of pair.test.sessions) {
          state.failedSessions.set(session, pair.test.id);
        }
      }
      const wasRunning =
        pair.test.id === worker.inFlightTestId && pair.test.serialId === undefined;
      if (!wasRunning) {
        this.options.events.onResult(
          unstartedResult(pair, {
            cause: 'infrastructure-unavailable',
            reason: 'worker process exited before this test started',
          }),
        );
        continue;
      }
      this.options.events.onResult(
        pairResult(pair, {
          status: 'failed',
          selected: true,
          attempts: [
            {
              id: uuidv7(),
              index: 0,
              status: 'failed',
              startedAt: timestamp(),
              durationMs: 0,
              steps: [],
              artifacts: [],
              error: serializeError(
                new InfrastructureError('WORKER_CRASH', 'worker process exited during this test'),
              ),
              secondaryErrors: [],
              cleanup: 'forced',
            },
          ],
        }),
      );
    }
  }

  /** Fails a target whose workers cannot boot; drains its queues with skips. */
  private failTarget(state: TargetState): void {
    state.failed = true;
    this.options.events.onRunError({
      error: serializeError(
        new InfrastructureError(
          'WORKER_INIT_FAILED',
          `workers for target "${state.target.name}" failed to start ${MAX_INIT_FAILURES} times; remaining units skipped`,
        ),
      ),
    });
    const units = [...state.setupQueue, ...state.fileQueue];
    state.setupQueue.length = 0;
    state.fileQueue.length = 0;
    for (const unit of units) {
      for (const pair of unit.pairs) {
        this.options.events.onResult(
          unstartedResult(pair, {
            cause: 'infrastructure-unavailable',
            reason: 'worker process failed to start',
          }),
        );
      }
    }
  }

  /** Shuts every remaining worker down, force-killing stragglers. */
  private async drain(): Promise<void> {
    const remaining = [...this.workers];
    for (const worker of remaining) {
      if (worker.state !== 'retired' && worker.runner.alive) worker.shutdown(SHUTDOWN_GRACE_MS);
    }
    await Promise.all(remaining.map((worker) => worker.runner.exit));
  }
}
