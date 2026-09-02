/**
 * Target worker core: the single implementation of "execute work units for one
 * target and stream records back". Both transports (child process and
 * in-process) drive this class, so unit execution, interrupt handling, and
 * run-error forwarding exist exactly once.
 */

import type { TestIdentity } from '../../collect/collect.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../../config/resolve.ts';
import type { Driver } from '../../driver/index.ts';
import { DebugTrace } from '../../internal/debug.ts';
import { TargetExecutor } from '../execute.ts';
import type { RunError } from '../records.ts';
import type { SessionStore } from '../sessions.ts';
import { disappearedResult } from '../units.ts';
import { encodeResult, type MainToWorker, type RunUnitMessage, type WorkerToMain } from './protocol.ts';

/** Pairs resolved locally for one unit, plus identities that vanished. */
export interface ResolvedUnitPairs {
  readonly pairs: readonly TestTargetPair[];
  /** Planned tests absent from this worker's view of the file. */
  readonly missing: readonly TestIdentity[];
}

/**
 * Turns a unit's wire pairs into executable pairs. A child-process worker
 * re-imports the file; an in-process worker looks the pairs up in the
 * selection the runner already collected.
 */
export type ResolveUnitPairs = (unit: RunUnitMessage) => Promise<ResolvedUnitPairs>;

export interface TargetWorkerDeps {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  /** Undefined for backend targets: the worker never owns a driver then. */
  readonly driver: Driver | undefined;
  readonly sessionStore: SessionStore;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly headed: boolean;
  readonly resolvePairs: ResolveUnitPairs;
  readonly debug?: DebugTrace;
  /**
   * Whether end of life disposes the driver. Child-process workers own their
   * driver outright; in-process workers share the runner's instance, which the
   * runner disposes once at the end of the run.
   */
  readonly disposeDriver: boolean;
}

/** Transport callbacks a target worker needs. */
export interface TargetWorkerHost {
  emit(message: WorkerToMain): void;
  /** Unrecoverable failure: the worker must be treated as dead afterwards. */
  fatal(cause: unknown): void;
  /** Graceful end of life, after driver disposal. */
  finished(): void;
}

export class TargetWorker {
  private readonly interruptController = new AbortController();
  private deps: TargetWorkerDeps | undefined;
  private executor: TargetExecutor | undefined;
  private runErrorWatermark = 0;
  /** Serializes message handling so units never overlap on one worker. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: TargetWorkerHost,
    private readonly bootstrap: () => Promise<TargetWorkerDeps>,
  ) {}

  /** Boots the worker and announces readiness. Enqueued like any other work. */
  start(): void {
    this.enqueue(async () => {
      const deps = await this.bootstrap();
      this.deps = deps;
      this.executor = new TargetExecutor({
        config: deps.config,
        target: deps.target,
        driver: deps.driver,
        runId: deps.runId,
        artifactsRoot: deps.artifactsRoot,
        sessionStore: deps.sessionStore,
        headed: deps.headed,
        interruptSignal: this.interruptController.signal,
        ...(deps.debug !== undefined ? { debug: deps.debug } : {}),
        events: {
          onResult: (result) => this.host.emit({ type: 'result', result: encodeResult(result) }),
          onSerialGroup: (group) => this.host.emit({ type: 'serial-group', group }),
          onPairStart: (pair) =>
            this.host.emit({
              type: 'pair-start',
              testId: pair.test.id,
              title: pair.test.titlePath.join(' \u203a '),
            }),
          onProgress: (testId, progress) => this.host.emit({ type: 'progress', testId, progress }),
        },
      });
      this.host.emit({ type: 'ready' });
    });
  }

  handle(message: MainToWorker): void {
    switch (message.type) {
      case 'interrupt':
        this.interruptController.abort();
        return;
      case 'run-unit':
        this.enqueue(() => this.runUnit(message));
        return;
      case 'shutdown':
        this.enqueue(() => this.shutdown());
        return;
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((cause: unknown) => {
      this.host.fatal(cause);
    });
  }

  private async runUnit(message: RunUnitMessage): Promise<void> {
    const deps = this.deps;
    const executor = this.executor;
    if (deps === undefined || executor === undefined) {
      throw new Error('received a work unit before the worker finished starting');
    }
    try {
      const { pairs, missing } = await deps.resolvePairs(message);
      for (const test of missing) {
        executor.recordDisappeared(
          `test ${test.id} disappeared before execution; registration must be deterministic`,
        );
        executor.emit(disappearedResult(test, deps.target));
      }
      if (message.kind === 'setup') {
        for (const pair of pairs) await executor.runSetupUnit(pair);
      } else {
        await executor.runFileUnit(
          { file: message.file, absolutePath: message.absolutePath },
          pairs,
        );
      }
    } finally {
      this.host.emit({
        type: 'unit-done',
        unitId: message.unitId,
        runErrors: this.drainRunErrors(executor),
      });
    }
  }

  /** Run errors accumulate on the executor; forward only the new ones. */
  private drainRunErrors(executor: TargetExecutor): readonly RunError[] {
    const runErrors = executor.collectedRunErrors();
    const delta = runErrors.slice(this.runErrorWatermark);
    this.runErrorWatermark = runErrors.length;
    return delta;
  }

  private async shutdown(): Promise<void> {
    // The backend belongs to this worker's executor on both transports; the
    // driver is owned by the worker only when it created it (child process).
    try {
      await this.executor?.dispose();
    } catch {
      // dispose is best-effort cleanup
    }
    if (this.deps?.disposeDriver === true) {
      try {
        await this.deps.driver?.dispose?.();
      } catch {
        // dispose is best-effort cleanup
      }
    }
    this.host.finished();
  }
}
