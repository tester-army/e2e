/**
 * The anonymous project id. Feature counts need to tell "one project run
 * many times" from "many projects", and a per-machine id cannot: the same
 * repository on two laptops would count twice, and one laptop with ten
 * projects would count once.
 *
 * Inside a git repository the id is the SHA-256 of the repository's root
 * commit, which every clone shares and no one can produce without the
 * repository itself; a commit hash carries no name, path, or remote. A
 * shallow clone has no root to offer: its boundary commits pose as roots and
 * move with every fetch, so it is treated like a directory outside git.
 * There, the project root path is hashed together with the machine's local
 * salt, so the id is stable on that machine and unrecoverable anywhere else.
 * In CI there is no salt, so a runner without a full history has no id: its
 * working directory is not a project.
 */

import { COMMIT_HASH, git } from '../internal/git.ts';
import { sha256Hex } from '../internal/ids.ts';

/** The lexically first root commit reachable from HEAD; undefined outside git and in a shallow clone. */
async function rootCommit(cwd: string): Promise<string | undefined> {
  const [shallow, roots] = await Promise.all([
    git(cwd, ['rev-parse', '--is-shallow-repository']),
    git(cwd, ['rev-list', '--max-parents=0', 'HEAD']),
  ]);
  // Only an explicit `false` counts: a git too old for the flag echoes it back instead.
  if (shallow !== 'false' || roots === undefined) return undefined;
  return roots
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => COMMIT_HASH.test(line))
    .toSorted()[0];
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
