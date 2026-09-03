/**
 * In-process `UnitRunner`, used when the config cannot cross a process
 * boundary — a programmatic `rawConfig` may hold live backend handles and
 * closures. Execution still goes through the scheduler and the same
 * `TargetWorker` core; only the transport and pair resolution differ, and the
 * scheduler is capped at one worker so nothing overlaps in this process.
 */

import type { TestIdentity } from '../collect/collect.ts';
import type { Selection, TestTargetPair } from '../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { classifyError, ConfigurationError, serializeError } from '../internal/errors.ts';
import type { DebugTrace } from '../internal/debug.ts';
import type { SessionStore } from './sessions.ts';
import type { SpawnUnitRunner, UnitRunner, UnitRunnerEvents } from './unit-runner.ts';
import type { MainToWorker, RunUnitMessage } from './worker/protocol.ts';
import { TargetWorker, type ResolvedUnitPairs, type TargetWorkerDeps } from './worker/session.ts';

export interface InProcessRunnerOptions {
  readonly config: ResolvedConfig;
  readonly selection: Selection;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly sessionStore: SessionStore;
  readonly headed: boolean;
  readonly debug: DebugTrace;
}

class InProcessRunner implements UnitRunner {
  readonly exit: Promise<void>;
  private readonly worker: TargetWorker;
  private readonly finish: () => void;
  private exited = false;
  private closing = false;

  constructor(
    private readonly targetName: string,
    private readonly events: UnitRunnerEvents,
    private readonly options: InProcessRunnerOptions,
  ) {
    let finish = (): void => undefined;
    this.exit = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.finish = finish;
    this.worker = new TargetWorker(
      {
        emit: (message) => {
          if (!this.exited) this.events.onMessage(message);
        },
        fatal: (cause) => {
          if (this.exited) return;
          this.events.onMessage({
            type: 'fatal',
            error: serializeError(classifyError(cause)),
          });
          this.close();
        },
        finished: () => this.end('shut down'),
      },
      () => this.bootstrap(),
    );
    this.worker.start();
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(message: MainToWorker): void {
    if (this.exited) return;
    // Interrupts must land even while winding down, so in-flight work aborts;
    // a forced teardown likewise, so the backend lets go now.
    if (this.closing && message.type !== 'interrupt' && message.type !== 'terminate') return;
    this.worker.handle(message);
  }

  /**
   * There is no process to signal, so an in-process worker cannot be forced to
   * stop mid-test: the best available equivalent is to stop accepting units and
   * wind down after the current one. `exit` therefore always means "this
   * worker's work has actually stopped", which the scheduler relies on when
   * draining and when synthesizing results for a lost unit.
   */
  kill(): void {
    this.close();
  }

  /** Stops accepting work and asks the queue to wind down. */
  private close(): void {
    if (this.exited || this.closing) return;
    this.closing = true;
    this.worker.handle({ type: 'shutdown' });
  }

  private end(detail: string): void {
    if (this.exited) return;
    this.exited = true;
    this.events.onExit(detail);
    this.finish();
  }

  private async bootstrap(): Promise<TargetWorkerDeps> {
    const { config } = this.options;
    const target = config.targets.find((candidate) => candidate.name === this.targetName);
    if (target === undefined) {
      throw new ConfigurationError('UNKNOWN_TARGET', `unknown target "${this.targetName}"`);
    }
    return {
      config,
      target,
      sessionStore: this.options.sessionStore,
      runId: this.options.runId,
      artifactsRoot: this.options.artifactsRoot,
      headed: this.options.headed,
      debug: this.options.debug,
      resolvePairs: (unit) => resolveFromSelection(this.options.selection, target, unit),
    };
  }
}

/** Looks the unit's pairs up in the selection the runner already collected. */
async function resolveFromSelection(
  selection: Selection,
  target: ResolvedTarget,
  unit: RunUnitMessage,
): Promise<ResolvedUnitPairs> {
  const selected = selection.perTarget.find((entry) => entry.target.name === target.name);
  const available = new Map<string, TestTargetPair>();
  for (const pair of selected?.pairs ?? []) available.set(pair.test.id, pair);

  const pairs: TestTargetPair[] = [];
  const missing: TestIdentity[] = [];
  for (const wire of unit.pairs) {
    const pair = available.get(wire.test.id);
    if (pair === undefined) missing.push(wire.test);
    else pairs.push(pair);
  }
  return { pairs, missing };
}

/** Creates the spawn factory the scheduler uses for in-process execution. */
export function inProcessSpawner(options: InProcessRunnerOptions): SpawnUnitRunner {
  return (targetName, events) => new InProcessRunner(targetName, events, options);
}
