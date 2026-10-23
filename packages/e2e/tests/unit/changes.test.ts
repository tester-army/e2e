/**
 * The change test filters judge with `--changed-since`, read from real
 * throwaway git repositories: what the file list holds, what git it needs,
 * and every way a lookup fails, each `INVALID_CHANGED_SINCE`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findChanges } from '../../src/run/changes.ts';
import type { TestFilterChanges } from '../../src/types.ts';
import { commitFiles, initRepo, runGit, useTempDirs } from '../helpers/git-repo.ts';

const tempDir = useTempDirs();

/**
 * A repository whose `main` holds `file.txt` and `src/app.ts`, then a
 * `feature` branch, checked out, that edits `src/app.ts` and adds
 * `tests/new.e2e.ts`; `main` moves on after the branch point with
 * `docs/later.md`, which the change never holds.
 */
function featureRepo() {
  const dir = tempDir();
  initRepo(dir);
  const base = commitFiles(dir, { 'src/app.ts': 'one\n' }, 'app');
  runGit(dir, 'checkout', '--quiet', '-b', 'feature');
  commitFiles(dir, { 'src/app.ts': 'two\n', 'tests/new.e2e.ts': 'test\n' }, 'feature');
  runGit(dir, 'checkout', '--quiet', 'main');
  commitFiles(dir, { 'docs/later.md': 'later\n' }, 'later');
  runGit(dir, 'checkout', '--quiet', 'feature');
  return { dir, base };
}

/** `findChanges` in `cwd` with `options` over the change since `main` and a live signal. */
function lookUp(cwd: string, options: Partial<Parameters<typeof findChanges>[0]> = {}): Promise<TestFilterChanges> {
  return findChanges({ cwd, changedSince: 'main', signal: new AbortController().signal, ...options });
}

/** The files a lookup found, failing the test when it found none. */
function filesOf(lookup: TestFilterChanges): readonly string[] {
  if (lookup.files.length === 0) throw new Error(`expected a change since ${lookup.base}`);
  return lookup.files;
}

/** A clone of `dir`'s `branch`, `depth` commits deep, as actions/checkout makes one. */
function shallowClone(dir: string, branch: string, depth: number): string {
  const clone = path.join(tempDir(), 'shallow');
  runGit(path.dirname(clone), 'clone', '--quiet', '--depth', String(depth), '--branch', branch, `file://${dir}`, clone);
  return clone;
}

describe('findChanges with --changed-since', () => {
  it('measures from the merge base of the ref and HEAD, at the repository root, sorted and frozen', async () => {
    const { dir, base } = featureRepo();
    const lookup = await lookUp(dir);
    expect(lookup).toEqual({ base, root: realpathSync(dir), files: ['src/app.ts', 'tests/new.e2e.ts'] });
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(Object.isFrozen(lookup.files)).toBe(true);

    // Asked from a subdirectory, paths stay repository-relative, and untracked files outside it count too.
    writeFileSync(path.join(dir, 'root-new.ts'), 'new\n');
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'new\n');
    expect(filesOf(await lookUp(path.join(dir, 'src')))).toEqual(['root-new.ts', 'src/app.ts', 'src/new.ts', 'tests/new.e2e.ts']);
  });

  it('includes staged, unstaged, deleted, and untracked files, those in an untracked directory too, never an ignored one or a nested repository, which git lists as its directory, sorted by code point', async () => {
    const { dir } = featureRepo();
    writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    writeFileSync(path.join(dir, 'staged.ts'), 'new\n');
    runGit(dir, 'add', 'staged.ts');
    writeFileSync(path.join(dir, 'file.txt'), 'edited\n');
    rmSync(path.join(dir, 'src', 'app.ts'));
    writeFileSync(path.join(dir, 'untracked.ts'), 'new\n');
    writeFileSync(path.join(dir, '\u{1F600}.ts'), 'new\n');
    writeFileSync(path.join(dir, '～.ts'), 'new\n');
    mkdirSync(path.join(dir, 'build'));
    writeFileSync(path.join(dir, 'build', 'out.js'), 'ignored\n');
    mkdirSync(path.join(dir, 'plain'));
    writeFileSync(path.join(dir, 'plain', 'g.txt'), 'new\n');
    mkdirSync(path.join(dir, 'tools'));
    initRepo(path.join(dir, 'tools'));
    const files = filesOf(await lookUp(dir));
    expect(files).toEqual(['.gitignore', 'file.txt', 'plain/g.txt', 'src/app.ts', 'staged.ts', 'tests/new.e2e.ts', 'untracked.ts', '～.ts', '\u{1F600}.ts']);
  });

  it.skipIf(process.platform === 'win32')("never passes --no-relative, which git before 2.28, such as Ubuntu 20.04's 2.25, rejects", async () => {
    const { dir } = featureRepo();
    const bin = tempDir();
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor arg; do [ "$arg" = --no-relative ] && exit 129; done\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
    try {
      expect(filesOf(await lookUp(dir))).toEqual(['src/app.ts', 'tests/new.e2e.ts']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lists both paths of a rename', async () => {
    const { dir } = featureRepo();
    runGit(dir, 'mv', 'file.txt', 'moved.txt');
    commitFiles(dir, {}, 'rename');
    expect(filesOf(await lookUp(dir))).toEqual(['file.txt', 'moved.txt', 'src/app.ts', 'tests/new.e2e.ts']);
  });

  it('finds no change, naming the merge base, when the working tree matches it', async () => {
    const { dir } = featureRepo();
    const head = runGit(dir, 'rev-parse', 'HEAD');
    expect(await lookUp(dir, { changedSince: 'HEAD' })).toEqual({ base: head, root: realpathSync(dir), files: [] });
  });

  it('resolves a ref whose syntax takes the rest of the text, as a commit message search does', async () => {
    const { dir, base } = featureRepo();
    const subject = runGit(dir, 'log', '-1', '--format=%s', base);
    expect((await lookUp(dir, { changedSince: `:/${subject}` })).base).toBe(base);
  });

  it('is INVALID_CHANGED_SINCE for a ref that names no commit, or one with unrelated history', async () => {
    const { dir } = featureRepo();
    await expect(lookUp(dir, { changedSince: 'origin/mian' })).rejects.toMatchObject({
      category: 'configuration',
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "origin/mian" names no commit in this checkout; fetch it, such as with fetch-depth: 0 on actions/checkout or GIT_DEPTH: 0 on GitLab',
    });
    runGit(dir, 'checkout', '--quiet', '--orphan', 'unrelated');
    commitFiles(dir, { 'other.txt': 'x\n' }, 'unrelated');
    runGit(dir, 'checkout', '--quiet', 'feature');
    // A full clone holds every commit: more history cannot help.
    await expect(lookUp(dir, { changedSince: 'unrelated' })).rejects.toMatchObject({
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "unrelated" shares no history with HEAD: their histories are unrelated; name a ref on the history of HEAD',
    });
  });

  it('is INVALID_CHANGED_SINCE saying to fetch more history when a shallow checkout lacks the merge base', async () => {
    const { dir } = featureRepo();
    const clone = shallowClone(dir, 'feature', 1);
    runGit(clone, 'fetch', '--quiet', '--depth', '1', 'origin', 'main:refs/remotes/origin/main');
    await expect(lookUp(clone, { changedSince: 'origin/main' })).rejects.toMatchObject({
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "origin/main" shares no history with HEAD in this checkout; fetch more history, such as git fetch --unshallow',
    });
  });

  it('is INVALID_CHANGED_SINCE outside a repository, quoting git, when git is missing, and when git runs out of budget', async () => {
    await expect(lookUp(tempDir())).rejects.toMatchObject({
      category: 'configuration',
      code: 'INVALID_CHANGED_SINCE',
      message: expect.stringMatching(/^--changed-since "main": git rev-parse: not a git repository/),
    });

    const { dir } = featureRepo();
    vi.stubEnv('PATH', tempDir());
    try {
      await expect(lookUp(dir)).rejects.toMatchObject({ code: 'INVALID_CHANGED_SINCE', message: '--changed-since "main": git was not found' });
    } finally {
      vi.unstubAllEnvs();
    }

    await expect(lookUp(dir, { budgetMs: 1 })).rejects.toMatchObject({
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "main": git did not answer within 1ms',
    });
  });

  it('rejects INTERRUPTED once the run is interrupted', async () => {
    const { dir } = featureRepo();
    const controller = new AbortController();
    controller.abort();
    await expect(lookUp(dir, { signal: controller.signal })).rejects.toMatchObject({
      category: 'interrupted',
      code: 'INTERRUPTED',
      message: 'interrupted while finding the change the test filters judge',
    });
  });
});
