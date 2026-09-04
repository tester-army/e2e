/**
 * The one seam to the tmux binary: every command the backend issues is one
 * `tmux -L <socket> ...` process, and its failure is translated onto the
 * contract's error codes here. The runner type is what unit tests script, so
 * the whole backend is testable without a tmux server.
 */

import { execFile } from 'node:child_process';
import { BackendError } from '@e2edev/e2e/backend';
import { cancelled, failure, invalidState } from './support.ts';

/** Runs one tmux command line (the arguments after `tmux -L <socket>`) and resolves with its stdout. */
export type TmuxRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

const MISSING_TARGET_PATTERN = /can't find|no server running|no such|not found|no current|no sessions/i;

/** A runner over the real binary on one private socket. */
export function createTmuxRunner(tmuxPath: string, socket: string): TmuxRunner {
  return (args, signal) =>
    new Promise<string>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(cancelled(`tmux ${args[0] ?? ''} cancelled`));
        return;
      }
      execFile(
        tmuxPath,
        ['-L', socket, ...args],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          reject(translate(error, stderr, args, tmuxPath));
        },
      );
    });
}

/** Translates one failed tmux process onto the error contract. */
function translate(error: Error & { code?: unknown }, stderr: string, args: readonly string[], tmuxPath: string): BackendError {
  const command = args[0] ?? 'tmux';
  if (error.name === 'AbortError') return cancelled(`tmux ${command} cancelled`);
  if (error.code === 'ENOENT') {
    return failure(`tmux binary "${tmuxPath}" was not found; install tmux or set the backend option \`tmuxPath\``, error);
  }
  const detail = stderr.trim() === '' ? error.message : stderr.trim();
  if (MISSING_TARGET_PATTERN.test(detail)) return invalidState(`tmux ${command} failed: ${detail}`);
  return failure(`tmux ${command} failed: ${detail}`, error);
}
