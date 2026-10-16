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
 * move with every fetch, so it has no id, like a directory outside git: a
 * path is the same project on one machine only, so it cannot be told apart
 * from a scratch directory nobody returns to.
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

/** The hashed root commit of the repository at `projectRoot`; undefined outside git and in a shallow clone. */
export async function anonymousProjectId(projectRoot: string): Promise<string | undefined> {
  const commit = await rootCommit(projectRoot);
  return commit === undefined ? undefined : sha256Hex(`git\n${commit}`);
}
