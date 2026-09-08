/**
 * Target worker core: the single implementation of "execute work units for one
 * target and stream records back". Both transports (child process and
 * in-process) drive this class, so unit execution, interrupt handling, and
 * run-error forwarding exist exactly once.
 */

import type { TestIdentity } from '../../collect/collect.ts';
import type { ModuleRegistration } from '../../collect/registry.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../../config/resolve.ts';
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
  /**
   * The module registration the resolver imported to resolve the pairs, when
   * it imported one. Nothing has run in it, so the executor adopts it as the
   * unit's first realm instead of importing the same file a second time.
   */
  readonly registration?: ModuleRegistration;
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
  readonly sessionStore: SessionStore;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly headed: boolean;
  /** Whether the worker has a process of its own; see `TargetExecutorOptions.isolated`. */
  readonly isolated: boolean;
  readonly resolvePairs: ResolveUnitPairs;
  readonly debug?: DebugTrace;
}

/** Transport callbacks a target worker needs. */
export interface TargetWorkerHost {
  emit(message: WorkerToMain): void;
  /** Unrecoverable failure: the worker must be treated as dead afterwards. */
  fatal(cause: unknown): void;
  /** Graceful end of life, after engine disposal. */
  finished(): void;
}

export class TargetWorker {
  private readonly interruptController = new AbortController();
  private deps: TargetWorkerDeps | undefined;
  private executor: TargetExecutor | undefined;
  private runErrorWatermark = 0;
  /** Serializes message handling so units never overlap on one worker. */
  private queue: Promise<void> = Promise.resolve();
  /** Disposal happens once, whichever of shutdown or terminate asks first. */
  private shutdownOnce: Promise<void> | undefined;

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
        runId: deps.runId,
        artifactsRoot: deps.artifactsRoot,
        sessionStore: deps.sessionStore,
        headed: deps.headed,
        isolated: deps.isolated,
        interruptSignal: this.interruptController.signal,
        ...(deps.debug !== undefined ? { debug: deps.debug } : {}),
        events: {
          onResult: (result) => this.host.emit({ type: 'result', result: encodeResult(result) }),
          onSerialGroup: (group) => this.host.emit({ type: 'serial-group', group }),
          onPairStart: (pair) =>
            this.host.emit({
              type: 'pair-start',
              testId: pair.test.id,
              title: pair.test.titlePath.join(' > '),
              file: pair.test.file,
              serialId: pair.test.serialId,
            }),
          onProgress: (testId, progress) => this.host.emit({ type: 'progress', testId, progress }),
          onRunAbort: (runError) => {
            this.interruptController.abort();
            this.host.emit({ type: 'run-abort', error: runError.error });
          },
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
      case 'terminate':
        this.terminate();
        return;
    }
  }

  /**
   * A forced interrupt. Disposal runs beside the running unit instead of
   * queued behind it: the unit is exactly what a second interrupt refuses to
   * wait for. Its later engine calls fail against a disposed engine, which
   * no longer matters — nothing it reports from here on is kept.
   */
  private terminate(): void {
    this.interruptController.abort();
    this.shutdown().catch((cause: unknown) => {
      this.host.fatal(cause);
    });
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
    // `unit-done` is sent only when the unit ran to completion. A throw here
    // (a module that fails to re-import, a realm that cannot be created) is
    // fatal for the worker; the scheduler still holds the unit and synthesizes
    // failed results for every pair it never heard about. Reporting the unit
    // done first would clear that bookkeeping and drop those tests silently.
    const { pairs, missing, registration } = await deps.resolvePairs(message);
    for (const test of missing) {
      executor.recordDisappeared(
        `test ${test.id} disappeared before execution; registration must be deterministic`,
      );
      executor.emit(disappearedResult(test, deps.target));
    }
    if (message.kind === 'setup') {
      // The imported registration has run nothing yet, so only the first
      // setup pair may adopt it; any later one needs its own fresh realm.
      for (const [index, pair] of pairs.entries()) {
        await executor.runSetupUnit(pair, index === 0 ? registration : undefined);
      }
    } else {
      await executor.runFileUnit(
        { file: message.file, absolutePath: message.absolutePath },
        pairs,
        registration,
      );
    }
    this.host.emit({
      type: 'unit-done',
      unitId: message.unitId,
      runErrors: this.drainRunErrors(executor),
    });
  }

  /** Run errors accumulate on the executor; forward only the new ones. */
  private drainRunErrors(executor: TargetExecutor): readonly RunError[] {
    const runErrors = executor.collectedRunErrors();
    const delta = runErrors.slice(this.runErrorWatermark);
    this.runErrorWatermark = runErrors.length;
    return delta;
  }

  private shutdown(): Promise<void> {
    this.shutdownOnce ??= this.disposeAndFinish();
    return this.shutdownOnce;
  }

  private async disposeAndFinish(): Promise<void> {
    // The engine belongs to this worker's executor on both transports. Its
    // disposal records run errors after the last unit drained, so they ship
    // on a final message of their own; dispose itself never throws.
    const executor = this.executor;
    if (executor !== undefined) await executor.dispose();
    this.host.emit({
      type: 'shutdown-done',
      runErrors: executor === undefined ? [] : this.drainRunErrors(executor),
    });
    this.host.finished();
  }
}
