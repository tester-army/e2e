/** Throwaway git repositories for tests that read what git says about a checkout. */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Runs git in `cwd` with the user's config shut out, returning trimmed stdout. */
export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.test',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.test',
    },
  }).trim();
}

/** Initializes `dir` as a repository on `main` with one commit of `file.txt`, and returns that commit. */
export function initRepo(dir: string): string {
  runGit(dir, 'init', '--quiet');
  writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  runGit(dir, 'add', 'file.txt');
  runGit(dir, 'commit', '--quiet', '-m', 'one');
  return runGit(dir, 'rev-parse', 'HEAD');
}
