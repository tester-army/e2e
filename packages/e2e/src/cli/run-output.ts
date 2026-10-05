/**
 * The `e2e run` process's stdout and stderr. User code runs in this process
 * too (the config's top-level code, test files while they are collected,
 * reporters) and may print a secret, so every write to either stream goes
 * through a `RunnerOutput`, redacted, until the process exits; only the list
 * reporter writes to the terminal past it.
 */

import { RunnerOutput, type OutputStream } from '../run/process-output.ts';
import { processSecrets } from '../run/secrecy.ts';

/**
 * Encodings in which a string spells bytes rather than text: the write puts
 * those bytes on the terminal, so they are what is redacted. A string in any
 * other encoding is the text itself, redacted and written as UTF-8.
 */
const BYTE_ENCODINGS: ReadonlySet<BufferEncoding> = new Set(['hex', 'base64', 'base64url']);

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
  const streams = { stdout: process.stdout, stderr: process.stderr } as const;
  const terminal = {
    stdout: streams.stdout.write.bind(streams.stdout) as (text: string, callback?: () => void) => boolean,
    stderr: streams.stderr.write.bind(streams.stderr) as (text: string, callback?: () => void) => boolean,
  };
  const output = new RunnerOutput(terminal, processSecrets);
  for (const name of ['stdout', 'stderr'] as const satisfies readonly OutputStream[]) {
    streams[name].write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const bytes = typeof chunk === 'string' && typeof encoding === 'string' && BYTE_ENCODINGS.has(encoding);
      return output.write(name, bytes ? Buffer.from(chunk, encoding) : chunk, done);
    }) as typeof process.stdout.write;
  }
  process.once('exit', () => output.end());
  claimed = output;
  return output;
}
