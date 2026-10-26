/** Throwaway git repositories for tests that read what git says about a checkout. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

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

/** Writes `files` under `dir` (an empty string removes the file), commits every change as `message`, and returns the commit. */
export function commitFiles(dir: string, files: Readonly<Record<string, string>>, message = 'change'): string {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    if (content === '') {
      rmSync(absolute, { force: true });
      continue;
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  runGit(dir, 'add', '--all');
  runGit(dir, 'commit', '--quiet', '-m', message);
  return runGit(dir, 'rev-parse', 'HEAD');
}

/**
 * Makes fresh empty directories under the system temp directory, resolved
 * so a test crosses no symlink it did not make (macOS keeps it behind
 * `/var`), and removes them after each test in the calling file.
 */
export function useTempDirs(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = realpathSync(os.tmpdir());
  return () => {
    const dir = mkdtempSync(path.join(temp, 'e2e-git-'));
    dirs.push(dir);
    return dir;
  };
}
