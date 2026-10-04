/**
 * The `e2e run` process's stdout and stderr. User code runs in this process
 * too (the config's top-level code, test files while they are collected,
 * reporters) and may print a secret, so every write to either stream goes
 * through a `RunnerOutput`, redacted; only the list reporter writes to the
 * terminal past it.
 */

import { RunnerOutput, type OutputStream } from '../run/process-output.ts';
import { processSecrets } from '../run/secrecy.ts';

/**
 * Encodings in which a string spells bytes rather than text: the write puts
 * those bytes on the terminal, so they are what is redacted. A string in any
 * other encoding is the text itself, redacted and written as UTF-8.
 */
const BYTE_ENCODINGS: ReadonlySet<BufferEncoding> = new Set(['hex', 'base64', 'base64url']);

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
      const bytes = typeof chunk === 'string' && typeof encoding === 'string' && BYTE_ENCODINGS.has(encoding);
      return output.write(name, bytes ? Buffer.from(chunk, encoding) : chunk, done);
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
