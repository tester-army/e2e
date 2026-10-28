import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import { packageVersion } from '../internal/package-version.ts';
import { runsFromCheckout } from '../telemetry/checkout.ts';
import { runCompletedEvent } from '../telemetry/events.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import type { Report } from '../types.ts';
import type { RunEventSink, RunExitCode, RunStatus } from './events.ts';
import { withProcessOutput, type RunnerOutput } from './process-output.ts';
import { reserveSuiteRun } from './public-ownership.ts';
import { processSecrets } from './secrecy.ts';
import {
  run as execute,
  toSelectionRunOptions,
  type ListOptions,
  type RunOptions as InternalRunOptions,
  type RunOutcome,
} from './runner.ts';

/** Options for executing a suite through the public runner API. */
export type SuiteRunOptions = Pick<ListOptions, 'cwd' | 'config' | 'files' | 'changedSince'> & Pick<InternalRunOptions, 'interruptSignal' | 'onEvent'>;

/** The completed run's report and output paths, without live engine or configuration handles. */
export interface RunResult {
  readonly exitCode: RunExitCode;
  readonly status: RunStatus;
  readonly report: Report;
  readonly reportPath: string | undefined;
  readonly aiTracePath: string | undefined;
}

/** What a public call takes from its caller to place the run and follow it. */
interface CallerOptions {
  readonly cwd?: string | undefined;
  readonly interruptSignal?: AbortSignal | undefined;
  readonly onEvent?: RunEventSink | undefined;
}

/** What the internal run receives in their place: output it owns, and the caller's cancellation and sink bound into its async context. */
interface OwnedRunOptions {
  readonly quiet: true;
  readonly processOutput: RunnerOutput;
  readonly interruptSignal: AbortSignal | undefined;
  readonly onEvent: RunEventSink | undefined;
}

/** Executes a suite without exiting the caller; await its cleanup before starting another run. */
export async function runSuite(options: SuiteRunOptions = {}): Promise<RunResult> {
  const outcome = await ownedRun('runner.run', options, (owned) =>
    execute({
      ...toSelectionRunOptions({ cwd: options.cwd, config: options.config, files: options.files, changedSince: options.changedSince }),
      ...owned,
    }),
  );
  return runResult(outcome);
}

/**
 * One public runner call: reserves the process before anything can change
 * its registries, owns and redacts its output, binds the caller's
 * cancellation and event sink into the run's async context, and records the
 * completed run's telemetry under `command`. The reservation is released
 * however `start` ends.
 */
export async function ownedRun<T extends RunOutcome>(
  command: string,
  caller: CallerOptions,
  start: (owned: OwnedRunOptions) => Promise<T>,
): Promise<T> {
  const release = reserveSuiteRun();
  try {
    const telemetry = new Telemetry({
      version: packageVersion(import.meta.url, '../../package.json', '0.0.0'),
      checkout: runsFromCheckout(import.meta.url),
      cwd: path.resolve(caller.cwd ?? process.cwd()),
    });
    telemetry.notice();
    const onEvent = caller.onEvent === undefined ? undefined : AsyncResource.bind(caller.onEvent);
    const outcome = await withProcessOutput(processSecrets, async (processOutput) => {
      const interrupt = ownedInterrupt(caller.interruptSignal);
      try {
        return await start({ quiet: true, processOutput, interruptSignal: interrupt.signal, onEvent });
      } finally {
        interrupt.dispose();
      }
    });
    telemetry.record(runCompletedEvent(outcome.report, { command, flags: [], config: outcome.config }));
    // The caller's result never waits on the network; the send has its own deadline.
    void telemetry.flush();
    return outcome;
  } finally {
    release();
  }
}

/** The outcome without the live engine and configuration handles a public caller never receives. */
export function runResult(outcome: RunOutcome): RunResult {
  const { exitCode, status, report, reportPath, aiTracePath } = outcome;
  return { exitCode, status, report, reportPath, aiTracePath };
}

/** Caller cancellation enters the suite's async context before invoking its listeners. */
function ownedInterrupt(signal: AbortSignal | undefined): { signal: AbortSignal | undefined; dispose(): void } {
  if (signal === undefined) return { signal: undefined, dispose: () => undefined };
  const controller = new AbortController();
  const abort = AsyncResource.bind(() => controller.abort(signal.reason));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose: () => signal.removeEventListener('abort', abort) };
}
