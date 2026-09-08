/**
 * The anonymous project id. Feature counts need to tell "one project run
 * many times" from "many projects", and a per-machine id cannot: the same
 * repository on two laptops would count twice, and one laptop with ten
 * projects would count once.
 *
 * Inside a git repository the id is the SHA-256 of the repository's root
 * commit, which every clone shares and no one can produce without the
 * repository itself; a commit hash carries no name, path, or remote. Outside
 * git the project root path is hashed together with the machine's local salt,
 * so the id is stable on that machine and unrecoverable anywhere else. In CI
 * without git there is no id: a runner's working directory is not a project.
 */

import { execFile } from 'node:child_process';
import { sha256Hex } from '../internal/ids.ts';

const COMMIT_HASH = /^[a-f0-9]{40,64}$/u;

/** The lexically first root commit reachable from HEAD, or undefined outside git. */
function rootCommit(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['rev-list', '--max-parents=0', 'HEAD'],
        { cwd, timeout: 1_000, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          if (error !== null) {
            resolve(undefined);
            return;
          }
          const roots = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => COMMIT_HASH.test(line))
            .toSorted();
          resolve(roots[0]);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

export async function anonymousProjectId(
  projectRoot: string,
  salt: string | undefined,
): Promise<string | undefined> {
  const commit = await rootCommit(projectRoot);
  if (commit !== undefined) return sha256Hex(`git\n${commit}`);
  if (salt === undefined) return undefined;
  return sha256Hex(`path\n${salt}\n${projectRoot}`);
}
