/**
 * Where the code under test came from, for the report. A verdict without a
 * commit cannot be joined to the pull request that produced the code, and a
 * platform that shows trust per test over time needs that join. Best-effort
 * and quick: git is asked with a one-second budget, and a checkout without
 * git falls back to what CI tells the process. Nothing here fails a run.
 */

import { COMMIT_HASH, git } from './git.ts';

export interface VcsInfo {
  /** The commit the working tree is checked out at. */
  readonly commit: string;
  /** The branch name; absent on a detached HEAD or when only the commit is known. */
  readonly branch?: string;
  /** True when tracked files differ from the commit; absent when git could not say. */
  readonly dirty?: boolean;
}

/**
 * The commit, branch, and cleanliness of `projectRoot`: from git when it
 * answers, else from the CI variables GitHub Actions sets, else undefined.
 */
export async function detectVcs(projectRoot: string, env: NodeJS.ProcessEnv): Promise<VcsInfo | undefined> {
  const [commit, branch, status] = await Promise.all([
    git(projectRoot, ['rev-parse', 'HEAD']),
    git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectRoot, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  if (commit !== undefined && COMMIT_HASH.test(commit)) {
    return {
      commit,
      ...(branch === undefined || branch === '' || branch === 'HEAD' ? {} : { branch }),
      ...(status === undefined ? {} : { dirty: status !== '' }),
    };
  }
  const ciCommit = env['GITHUB_SHA'];
  if (ciCommit === undefined || !COMMIT_HASH.test(ciCommit)) return undefined;
  const ciBranch = env['GITHUB_HEAD_REF'] || env['GITHUB_REF_NAME'];
  return { commit: ciCommit, ...(ciBranch === undefined || ciBranch === '' ? {} : { branch: ciBranch }) };
}
