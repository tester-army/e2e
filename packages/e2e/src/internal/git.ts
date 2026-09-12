/**
 * The one way the runner asks git a question. Best-effort by design: git may
 * be missing, slow, or outside a repository, and none of that fails a run.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A full SHA-1 or SHA-256 object name. */
export const COMMIT_HASH = /^[a-f0-9]{40,64}$/u;

/** One git command's trimmed stdout; undefined when git is missing, slow, or refuses. */
export async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 1_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}
