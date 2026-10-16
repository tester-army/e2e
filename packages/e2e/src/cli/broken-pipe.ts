import type { Writable } from 'node:stream';

/**
 * A reader that stops early (`e2e --help | head -1`) closes the pipe, and the
 * next write fails with EPIPE, an `error` event that kills the process with a
 * stack trace when nothing listens. EPIPE is dropped instead: output nobody
 * reads is discarded and the command finishes as it would have, teardown and
 * exit code included. Any other error still throws, unless another listener
 * (the MCP server's, on its protocol pipe) handles it.
 */
export function ignoreBrokenPipes(streams: readonly Writable[]): void {
  for (const stream of streams) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || stream.listenerCount('error') > 1) return;
      throw error;
    });
  }
}
