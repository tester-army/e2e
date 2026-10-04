/**
 * The `e2e run` process's stdout and stderr. User code runs in this process
 * too (the config's top-level code, test files while they are collected,
 * reporters) and may print a secret, so every write to either stream goes
 * through a `RunnerOutput`, redacted; only the list reporter writes to the
 * terminal past it.
 */

import { RunnerOutput, type OutputStream } from '../run/process-output.ts';
import { processSecrets } from '../run/secrecy.ts';

/** Takes over `process.stdout` and `process.stderr` until the returned `release`, which flushes what is held and gives the streams back. */
export function claimRunnerOutput(): { output: RunnerOutput; release: () => void } {
  const streams = { stdout: process.stdout, stderr: process.stderr } as const;
  const originals = { stdout: streams.stdout.write, stderr: streams.stderr.write };
  const terminal = {
    stdout: originals.stdout.bind(streams.stdout) as (text: string, callback?: () => void) => boolean,
    stderr: originals.stderr.bind(streams.stderr) as (text: string, callback?: () => void) => boolean,
  };
  const output = new RunnerOutput(terminal, processSecrets);
  for (const name of ['stdout', 'stderr'] as const satisfies readonly OutputStream[]) {
    streams[name].write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const text = typeof chunk === 'string' && typeof encoding === 'string' ? Buffer.from(chunk, encoding) : chunk;
      return output.write(name, text, done);
    }) as typeof process.stdout.write;
  }
  return {
    output,
    release: () => {
      output.end();
      streams.stdout.write = originals.stdout;
      streams.stderr.write = originals.stderr;
    },
  };
}
