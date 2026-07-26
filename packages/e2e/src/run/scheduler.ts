/**
 * Parallel scheduler: dispatches file-target work units across worker
 * processes (spec 11-lifecycle.md). Per target, setup units complete before
 * ordinary units dispatch; a worker is bound to one target, runs one unit at
 * a time, and is discarded after any failing unit or infrastructure fault.
 */

import type { Collection } from '../collect/collect.ts';
import type { Selection, TestTargetPair } from '../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import {
  InfrastructureError,
  serializeError,
} from '../internal/errors.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.ts';
import { buildWorkPlans, nonRunResult, unstartedResult, type WorkUnit } from './units.ts';
import { WorkerHandle } from './worker/handle.ts';
import { decodeResult, type WirePair, type WorkerToMain } from './worker/protocol.ts';

export interface SchedulerEvents {
  onResult(result: ResultRecord): void;
  onSerialGroup(group: SerialGroupRecord): void;
  onRunError(error: RunError): void;
}

export interface RunParallelOptions {
  readonly config: ResolvedConfig;
  readonly configPath: string;
  readonly selection: Selection;
  readonly collection: Collection;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly sessionsRoot: string;
  readonly sessionKeyBase64: string;
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly interruptSignal: AbortSignal;
  readonly events: SchedulerEvents;
}

/** Consecutive worker-boot failures per target before its units are failed. */
const MAX_INIT_FAILURES = 2;

interface TargetState {
  readonly target: ResolvedTarget;
  readonly setupQueue: WorkUnit[];
  readonly fileQueue: WorkUnit[];
  pendingSetups: number;
  /** session name -> failed setup test id */
  readonly failedSessions: Map<string, string>;
  initFailures: number;
  failed: boolean;
}

interface DispatchedUnit {
  readonly unit: WorkUnit;
  readonly resultsReceived: Set<string>;
  inFlightTestId: string | undefined;
  sawFailure: boolean;
}

interface Slot {
  readonly id: number;
  handle: WorkerHandle;
  readonly targetName: string;
  state: 'initializing' | 'idle' | 'busy' | 'retiring';
  dispatched: DispatchedUnit | undefined;
  pendingUnit: WorkUnit | undefined;
  becameReady: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

/** Runs every selected unit across worker processes and streams records. */
export async function runParallel(options: RunParallelOptions): Promise<void> {
  await new ParallelScheduler(options).run();
}

class ParallelScheduler {
  private readonly targets = new Map<string, TargetState>();
  private readonly slots: Slot[] = [];
  private readonly retiredExits: Promise<void>[] = [];
  private slotCounter = 0;
  private wake: (() => void) | undefined;
  private interruptBroadcast = false;

  constructor(private readonly options: RunParallelOptions) {}

  async run(): Promise<void> {
    const plans = buildWorkPlans(
      this.options.selection,
      this.options.collection,
      this.options.config.projectRoot,
    );
    for (const plan of plans) {
      this.targets.set(plan.target.name, {
        target: plan.target,
        setupQueue: [...plan.setupUnits],
        fileQueue: [...plan.fileUnits],
        pendingSetups: plan.setupUnits.length,
        failedSessions: new Map(),
        initFailures: 0,
        failed: false,
      });
      if (!this.options.interruptSignal.aborted) {
        for (const pair of plan.immediate) this.options.events.onResult(nonRunResult(pair));
      }
    }

    const onInterrupt = () => this.wakeUp();
    this.options.interruptSignal.addEventListener('abort', onInterrupt, { once: true });
    try {
      for (;;) {
        this.handleInterrupt();
        this.dispatch();
        if (this.isDone()) break;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      this.options.interruptSignal.removeEventListener('abort', onInterrupt);
      await this.drainWorkers();
    }
  }

  private wakeUp(): void {
    const resolve = this.wake;
    this.wake = undefined;
    resolve?.();
  }

  private handleInterrupt(): void {
    if (!this.options.interruptSignal.aborted || this.interruptBroadcast) return;
    this.interruptBroadcast = true;
    for (const state of this.targets.values()) {
      state.setupQueue.length = 0;
      state.fileQueue.length = 0;
    }
    const budget = this.options.config.timeout + this.options.config.cleanupTimeout;
    for (const slot of this.slots) {
      slot.handle.send({ type: 'interrupt' });
      if (slot.state === 'busy') {
        slot.killTimer = setTimeout(() => slot.handle.kill(), budget);
      } else {
        this.retire(slot);
      }
    }
  }

  private isDone(): boolean {
    for (const state of this.targets.values()) {
      if (state.setupQueue.length > 0 || state.fileQueue.length > 0) return false;
    }
    return !this.slots.some(
      (slot) => slot.state === 'busy' || slot.pendingUnit !== undefined,
    );
  }

  // --- dispatch ---

  private dispatch(): void {
    if (this.options.interruptSignal.aborted) return;
    for (;;) {
      const next = this.nextDispatch();
      if (next === undefined) return;
      const { state, slot } = next;
      const unit = this.takeUnit(state);
      if (unit === undefined) continue;
      if (slot.state === 'idle') {
        this.sendUnit(slot, unit);
      } else {
        slot.pendingUnit = unit;
      }
    }
  }

  /** Finds one target with an available unit and a slot able to take it. */
  private nextDispatch(): { state: TargetState; slot: Slot } | undefined {
    for (const state of this.targets.values()) {
      if (this.peekUnit(state) === undefined) continue;
      const idle = this.slots.find(
        (slot) =>
          slot.targetName === state.target.name &&
          slot.state === 'idle' &&
          slot.pendingUnit === undefined,
      );
      if (idle !== undefined) return { state, slot: idle };
      const initializing = this.slots.find(
        (slot) =>
          slot.targetName === state.target.name &&
          slot.state === 'initializing' &&
          slot.pendingUnit === undefined,
      );
      if (initializing !== undefined) return { state, slot: initializing };
      if (this.slots.length < this.options.config.workers) {
        return { state, slot: this.spawn(state.target.name) };
      }
      const foreignIdle = this.slots.find(
        (slot) => slot.state === 'idle' && slot.targetName !== state.target.name,
      );
      if (foreignIdle !== undefined) {
        this.retire(foreignIdle);
        return { state, slot: this.spawn(state.target.name) };
      }
    }
    return undefined;
  }

  private peekUnit(state: TargetState): WorkUnit | undefined {
    if (state.failed) return undefined;
    if (state.setupQueue.length > 0) return state.setupQueue[0];
    if (state.pendingSetups > 0) return undefined;
    return state.fileQueue[0];
  }

  /** Pops the next unit, applying setup-failure gating; may complete it inline. */
  private takeUnit(state: TargetState): WorkUnit | undefined {
    for (;;) {
      const unit = this.peekUnit(state);
      if (unit === undefined) return undefined;
      if (unit.kind === 'setup') state.setupQueue.shift();
      else state.fileQueue.shift();
      const runnable: TestTargetPair[] = [];
      for (const pair of unit.pairs) {
        const failedSetup =
          pair.options.session === undefined
            ? undefined
            : state.failedSessions.get(pair.options.session);
        if (failedSetup === undefined) {
          runnable.push(pair);
          continue;
        }
        this.options.events.onResult({
          test: pair.test,
          target: pair.target,
          status: 'skipped',
          selected: true,
          skip: {
            cause: 'setup-failed',
            reason: `setup for session "${pair.options.session}" failed`,
            relatedId: failedSetup,
          },
          attempts: [],
        });
      }
      if (runnable.length === 0) {
        this.completeUnit(state, unit);
        continue;
      }
      return runnable.length === unit.pairs.length ? unit : { ...unit, pairs: runnable };
    }
  }

  private sendUnit(slot: Slot, unit: WorkUnit): void {
    slot.state = 'busy';
    slot.dispatched = {
      unit,
      resultsReceived: new Set(),
      inFlightTestId: undefined,
      sawFailure: false,
    };
    const pairs: WirePair[] = unit.pairs.map((pair) => ({
      testId: pair.test.id,
      options: pair.options,
    }));
    slot.handle.send({
      type: 'run-unit',
      unitId: unit.id,
      kind: unit.kind,
      file: unit.file,
      absolutePath: unit.absolutePath,
      pairs,
    });
  }

  /** Bookkeeping shared by clean completion and crash synthesis. */
  private completeUnit(state: TargetState, unit: WorkUnit): void {
    if (unit.kind === 'setup') state.pendingSetups -= 1;
  }

  // --- workers ---

  private spawn(targetName: string): Slot {
    this.slotCounter += 1;
    const slot: Slot = {
      id: this.slotCounter,
      handle: undefined as unknown as WorkerHandle,
      targetName,
      state: 'initializing',
      dispatched: undefined,
      pendingUnit: undefined,
      becameReady: false,
      killTimer: undefined,
    };
    const handle = new WorkerHandle(
      {
        configPath: this.options.configPath,
        projectRoot: this.options.config.projectRoot,
        configDigest: this.options.config.configDigest,
        targetName,
        runId: this.options.runId,
        artifactsRoot: this.options.artifactsRoot,
        headed: this.options.headed,
        sessionsRoot: this.options.sessionsRoot,
        sessionKeyBase64: this.options.sessionKeyBase64,
      },
      { projectRoot: this.options.config.projectRoot, env: this.options.env },
      {
        onMessage: (message) => this.onMessage(slot, message),
        onExit: (code, signal) => this.onExit(slot, code, signal),
      },
    );
    slot.handle = handle;
    this.slots.push(slot);
    return slot;
  }

  private retire(slot: Slot): void {
    slot.state = 'retiring';
    slot.handle.shutdown();
    this.removeSlot(slot);
    const timer = setTimeout(() => slot.handle.kill(), 10_000);
    this.retiredExits.push(slot.handle.exit.then(() => clearTimeout(timer)));
  }

  private removeSlot(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
  }

  private targetState(slot: Slot): TargetState {
    return this.targets.get(slot.targetName)!;
  }

  private onMessage(slot: Slot, message: WorkerToMain): void {
    switch (message.type) {
      case 'ready': {
        slot.becameReady = true;
        this.targetState(slot).initFailures = 0;
        if (slot.pendingUnit !== undefined) {
          const unit = slot.pendingUnit;
          slot.pendingUnit = undefined;
          slot.state = 'idle';
          this.sendUnit(slot, unit);
        } else {
          slot.state = 'idle';
        }
        this.wakeUp();
        break;
      }
      case 'pair-start': {
        if (slot.dispatched !== undefined) slot.dispatched.inFlightTestId = message.testId;
        break;
      }
      case 'result': {
        const state = this.targetState(slot);
        const result = decodeResult(message.result, state.target);
        slot.dispatched?.resultsReceived.add(result.test.id);
        if (
          result.status === 'failed' ||
          result.status === 'timed-out' ||
          result.status === 'interrupted'
        ) {
          if (slot.dispatched !== undefined) slot.dispatched.sawFailure = true;
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
        const dispatched = slot.dispatched;
        slot.dispatched = undefined;
        if (dispatched !== undefined) {
          this.completeUnit(this.targetState(slot), dispatched.unit);
          if (dispatched.sawFailure) {
            // Spec 11-lifecycle.md: discard the worker after a failing unit.
            this.retire(slot);
          } else {
            slot.state = 'idle';
          }
        }
        this.wakeUp();
        break;
      }
      case 'fatal': {
        this.options.events.onRunError({ error: message.error });
        slot.handle.kill();
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

  private onExit(slot: Slot, code: number | null, signal: NodeJS.Signals | null): void {
    if (slot.killTimer !== undefined) clearTimeout(slot.killTimer);
    const wasTracked = this.slots.includes(slot);
    this.removeSlot(slot);
    const state = this.targetState(slot);
    const dispatched = slot.dispatched;
    slot.dispatched = undefined;

    if (dispatched !== undefined) {
      this.options.events.onRunError({
        error: serializeError(
          new InfrastructureError(
            'WORKER_EXIT',
            `worker for target "${slot.targetName}" exited unexpectedly (code ${String(code)}, signal ${String(signal)}) during ${dispatched.unit.id}`,
          ),
        ),
      });
      this.synthesizeCrashResults(state, dispatched);
      this.completeUnit(state, dispatched.unit);
    } else if (wasTracked && !slot.becameReady) {
      state.initFailures += 1;
      if (state.initFailures >= MAX_INIT_FAILURES) this.failTarget(state);
    }
    this.wakeUp();
  }

  /** Emits records for a unit whose worker died before unit-done. */
  private synthesizeCrashResults(state: TargetState, dispatched: DispatchedUnit): void {
    const interrupted = this.options.interruptSignal.aborted;
    for (const pair of dispatched.unit.pairs) {
      if (dispatched.resultsReceived.has(pair.test.id)) continue;
      if (interrupted) {
        this.options.events.onResult(
          unstartedResult(pair, {
            cause: 'infrastructure-unavailable',
            reason: 'run interrupted before execution',
          }),
        );
        continue;
      }
      // A crashed setup never persisted its sessions; dependents must skip.
      if (pair.test.kind === 'setup') {
        for (const session of pair.test.sessions) {
          state.failedSessions.set(session, pair.test.id);
        }
      }
      const inFlight =
        pair.test.id === dispatched.inFlightTestId && pair.test.serialId === undefined;
      if (inFlight) {
        this.options.events.onResult({
          test: pair.test,
          target: pair.target,
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
        });
        continue;
      }
      this.options.events.onResult(
        unstartedResult(pair, {
          cause: 'infrastructure-unavailable',
          reason: 'worker process exited before this test started',
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
      this.completeUnit(state, unit);
    }
  }

  /** Gracefully shuts down remaining workers, force-killing stragglers. */
  private async drainWorkers(): Promise<void> {
    const remaining = [...this.slots];
    this.slots.length = 0;
    await Promise.all(
      remaining.map(async (slot) => {
        if (!slot.handle.alive) return;
        const timer = setTimeout(() => slot.handle.kill(), 10_000);
        slot.handle.shutdown();
        await slot.handle.exit;
        clearTimeout(timer);
      }),
    );
    await Promise.all(this.retiredExits);
  }
}
