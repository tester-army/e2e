/**
 * The `e2e run` process's stdout and stderr. User code runs in this process
 * too (the config's top-level code, test files while they are collected,
 * test filters, reporters) and may print a secret, so every write to either
 * stream goes through a `RunnerOutput`, redacted, until the process exits;
 * only the list reporter writes to the terminal past it.
 */

import { leftWorkBehind } from '../internal/abandoned.ts';
import { claimProcessOutput, type RunnerOutput } from '../run/process-output.ts';
import { processSecrets } from '../run/secrecy.ts';

/** The process's claimed output, once claimed: the wrappers stay for the rest of the process. */
let claimed: RunnerOutput | undefined;

/**
 * Takes over `process.stdout` and `process.stderr` for the rest of the
 * process, once: a reporter the run stopped waiting for, or a timer the
 * config or a test file set, can still print after the run. The caller ends
 * the run's output with `end()`, which flushes what is held and stops
 * showing output through the list reporter; later writes stay redacted, and
 * their last unfinished piece prints at exit.
 */
export function claimRunnerOutput(): RunnerOutput {
  if (claimed !== undefined) return claimed;
  const output = claimProcessOutput(processSecrets);
  process.once('exit', () => output.end());
  claimed = output;
  return output;
}

/**
 * Resolves once the terminal took everything the process wrote, through
 * the claimed output when there is one: what the CLI waits for before it
 * exits at once, after Ctrl-C or once it left work behind.
 */
async function drainRunnerOutput(): Promise<void> {
  if (claimed !== undefined) return claimed.drain();
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => void stream.write('', () => resolve()))));
}

/**
 * Exits once the output is out when the command was stopped by Ctrl-C
 * (exit 130), or stopped waiting for a test filter or a reporter past its
 * timeout or cancelled by a watch key: the work it left behind may ignore
 * its signal, such as the filter's request or the reporter's upload, and
 * nothing it does can change the run. Otherwise the process ends when its
 * work does, so a timer or exit hook user code left still runs.
 */
export async function exitIfStopped(exit: () => void = () => process.exit()): Promise<void> {
  if (process.exitCode !== 130 && !leftWorkBehind()) return;
  await drainRunnerOutput();
  exit();
}
