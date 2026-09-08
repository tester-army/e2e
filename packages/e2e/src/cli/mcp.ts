/**
 * The `e2e mcp` command: claims stdout for the protocol, then serves. Over
 * stdio, stdout is the JSON-RPC stream, so anything else that writes there
 * (a stray console.log, a library banner) would corrupt the handshake. The
 * transport gets its own stream on file descriptor 1 and everything else
 * that reaches process.stdout is redirected to stderr for the whole process.
 */

import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { isCiMode } from '../config/resolve.ts';
import { errorMessage, exitCodeForCategory, classifyError } from '../internal/errors.ts';
import { serveMcp } from '../mcp/server.ts';

export interface McpCommandOptions {
  config?: string | undefined;
  target?: string | undefined;
  headless?: boolean | undefined;
}

/** Diverts every later `process.stdout` write to stderr and returns a stream still bound to fd 1. */
function claimStdout(): Writable {
  const protocol = createWriteStream('', { fd: 1, autoClose: false });
  const stderr = process.stderr;
  process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) =>
    (stderr.write as (...args: unknown[]) => boolean)(chunk, encoding, callback)) as typeof process.stdout.write;
  return protocol;
}

/** Runs the server until the client disconnects or a signal arrives; returns the exit code. */
export async function mcp(version: string, options: McpCommandOptions): Promise<number> {
  const stdout = claimStdout();
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await serveMcp({
      cwd: process.cwd(),
      configPath: options.config,
      target: options.target,
      headed: options.headless !== true && !isCiMode(process.env),
      env: process.env,
      version,
      stdin: process.stdin,
      stdout,
      log: (line) => process.stderr.write(`e2e mcp: ${line}\n`),
      signal: stop.signal,
    });
  } catch (cause) {
    const error = classifyError(cause);
    process.stderr.write(`e2e mcp: ${error.code}: ${errorMessage(cause)}\n`);
    return exitCodeForCategory(error.category);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
