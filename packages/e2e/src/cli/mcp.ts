/**
 * The `e2e mcp` command: claims stdout for the protocol, then serves. Over
 * stdio, stdout is the JSON-RPC stream, so anything else that writes there
 * (a stray console.log, a library banner) would corrupt the handshake. The
 * transport keeps the process's own stdout writer, and everything else that
 * reaches process.stdout or process.stderr goes to stderr, redacted, for the
 * whole process: user code runs here and may print a secret.
 */

import { Writable } from 'node:stream';
import { errorMessage, exitCodeForCategory, classifyError } from '../internal/errors.ts';
import { McpOutput } from '../mcp/output.ts';
import { serveMcp, type ServeOptions } from '../mcp/server.ts';
import { processSecrets } from '../run/secrecy.ts';
import { mcpSessionEvent } from '../telemetry/events.ts';
import type { Telemetry } from '../telemetry/telemetry.ts';

export interface McpCommandOptions {
  config?: string | undefined;
  target?: string | undefined;
  headed?: boolean | undefined;
  maxSessions?: number | undefined;
}

/**
 * Takes over the process's stdout and stderr: the returned protocol stream
 * still reaches the real stdout, and every other write to either stream goes
 * through `output` to stderr. The protocol stream wraps the original writer
 * rather than opening file descriptor 1 again: once Node has set up
 * `process.stdout` on a pipe, the descriptor is non-blocking, and a plain
 * `fs` write to it fails with EAGAIN as soon as the client reads slower than
 * the server writes (a screenshot result), killing the server. The socket
 * writer queues and retries instead.
 */
function claimStdio(): { protocol: Writable; output: McpOutput } {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const writeStdout = stdout.write.bind(stdout) as (chunk: Buffer, callback: (error?: Error | null) => void) => boolean;
  const writeStderr = stderr.write.bind(stderr) as (chunk: string, callback?: () => void) => boolean;
  const output = new McpOutput((text, callback) => void writeStderr(text, callback), processSecrets);
  for (const [stream, name] of [
    [stdout, 'stdout'],
    [stderr, 'stderr'],
  ] as const) {
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const text = typeof chunk === 'string' && typeof encoding === 'string' ? Buffer.from(chunk, encoding) : chunk;
      output.write(name, text, done);
      return true;
    }) as typeof stream.write;
  }
  const protocol = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeStdout(chunk, callback);
    },
  });
  // A client that went away fails the pipe with EPIPE; the protocol stream
  // carries the error to the server, which closes its sessions and exits.
  // A client that captured stderr takes that pipe with it too, and the
  // diagnostics written while the sessions close must not kill the server
  // before its app processes stop.
  stdout.on('error', (error) => protocol.destroy(error));
  stderr.on('error', () => undefined);
  return { protocol, output };
}

/**
 * Records each MCP session as it ends and sends it at once: a server lives
 * as long as its client, and one its client kills never reaches the flush
 * at exit.
 */
export function sessionTelemetry(telemetry: Telemetry): NonNullable<ServeOptions['onSessionEnd']> {
  return (summary, client) => {
    telemetry.record(mcpSessionEvent(summary, client));
    void telemetry.sendQueued();
  };
}

/** Runs the server until the client disconnects or a signal arrives; returns the exit code. */
export async function mcp(version: string, options: McpCommandOptions, telemetry: Telemetry): Promise<number> {
  const { protocol, output } = claimStdio();
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await serveMcp({
      cwd: process.cwd(),
      configPath: options.config,
      target: options.target,
      headed: options.headed === true,
      maxSessions: options.maxSessions,
      env: process.env,
      version,
      stdin: process.stdin,
      stdout: protocol,
      log: (line) => output.log(`e2e mcp: ${line}`),
      withholdOutput: (load) => output.withholdDuring(load),
      signal: stop.signal,
      onSessionEnd: sessionTelemetry(telemetry),
    });
  } catch (cause) {
    const error = classifyError(cause);
    output.log(`e2e mcp: ${error.code}: ${processSecrets.redact(errorMessage(cause))}`);
    return exitCodeForCategory(error.category);
  } finally {
    output.flush();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
