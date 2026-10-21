/**
 * The one way the runner asks git a question. `runGit` answers whatever git
 * exits with and says why when git could not answer, for a caller that fails
 * on it. `git` is best-effort by design: git may be missing, slow, or outside
 * a repository, and none of that fails a run.
 */

import { execFile } from 'node:child_process';

/** A full SHA-1 or SHA-256 object name. */
export const COMMIT_HASH = /^[a-f0-9]{40,64}$/u;

/** One git call's exit code and output. */
export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How long one git call may run, and how much it may print. */
interface GitOptions {
  /** Aborting it kills git and rejects with the abort. */
  readonly signal?: AbortSignal;
  /** The most bytes git may print on stdout or stderr; default 1 MiB. */
  readonly maxBuffer?: number;
}

/** Git could not answer: it is missing, printed too much, or failed outright. The message says which. */
export class GitFailure extends Error {}

/**
 * Runs git once in `cwd`: its exit code and output, whatever the code. Git
 * that is missing or prints past `maxBuffer` is a `GitFailure`; an abort
 * rejects with the abort, and the caller reads its signal for why.
 */
export function runGit(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const { signal, maxBuffer = 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, signal, maxBuffer, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === 'number') {
        resolve({ exitCode: error.code, stdout, stderr });
        return;
      }
      if (signal?.aborted) reject(error);
      else if (error.code === 'ENOENT') reject(new GitFailure('git was not found'));
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new GitFailure(`git ${args[0] ?? ''} printed more than ${maxBuffer / 1024 / 1024} MiB`));
      else reject(new GitFailure(`git ${args[0] ?? ''}: ${error.message}`));
    });
  });
}

/** One git command's trimmed stdout; undefined when git is missing, slow, or refuses. */
export async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await runGit(cwd, args, { signal: AbortSignal.timeout(1_000) });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}
