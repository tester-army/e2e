import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import { packageVersion } from '../internal/package-version.ts';
import { runsFromCheckout } from '../telemetry/checkout.ts';
import { runCompletedEvent } from '../telemetry/events.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import type { Report } from '../types.ts';
import type { RunExitCode, RunStatus } from './events.ts';
import { withProcessOutput } from './process-output.ts';
import { reserveSuiteRun } from './public-ownership.ts';
import { processSecrets } from './secrecy.ts';
import { run as execute, toSelectionRunOptions, type ListOptions, type RunOptions as InternalRunOptions } from './runner.ts';

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

/** Executes a suite without exiting the caller; await its cleanup before starting another run. */
export async function runSuite(options: SuiteRunOptions = {}): Promise<RunResult> {
  const release = reserveSuiteRun();
  try {
    const telemetry = new Telemetry({
      version: packageVersion(import.meta.url, '../../package.json', '0.0.0'),
      checkout: runsFromCheckout(import.meta.url),
      cwd: path.resolve(options.cwd ?? process.cwd()),
    });
    telemetry.notice();
    const onEvent = options.onEvent === undefined ? undefined : AsyncResource.bind(options.onEvent);
    const outcome = await withProcessOutput(processSecrets, async (output) => {
      const interrupt = ownedInterrupt(options.interruptSignal);
      try {
        return await execute({
          ...toSelectionRunOptions({ cwd: options.cwd, config: options.config, files: options.files, changedSince: options.changedSince }),
          quiet: true,
          processOutput: output,
          interruptSignal: interrupt.signal,
          onEvent,
        });
      } finally {
        interrupt.dispose();
      }
    });
    telemetry.record(runCompletedEvent(outcome.report, { command: 'runner.run', flags: [], config: outcome.config }));
    // The caller's result never waits on the network; the send has its own deadline.
    void telemetry.flush();
    const { exitCode, status, report, reportPath, aiTracePath } = outcome;
    return { exitCode, status, report, reportPath, aiTracePath };
  } finally {
    release();
  }
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
