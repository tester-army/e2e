/**
 * The `e2e run` process's stdout and stderr. User code runs in this process
 * too (the config's top-level code, test files while they are collected,
 * reporters) and may print a secret, so every write to either stream goes
 * through a `RunnerOutput`, redacted, until the process exits; only the list
 * reporter writes to the terminal past it.
 */

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
