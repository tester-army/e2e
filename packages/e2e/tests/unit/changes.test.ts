/**
 * The change test filters judge, read from real throwaway git repositories:
 * `--changed-since`, a GitHub pull request (the event's base, the first
 * parent of GitHub's merge commit, `origin/<base>`), a GitLab merge request,
 * what the file list holds, what git it needs, and every way a lookup fails:
 * loud for the flag, a warning for a detected request.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { E2EError } from '../../src/internal/errors.ts';
import { findChanges, type ChangeLookup, type ChangeOptions } from '../../src/run/changes.ts';
import { commitFiles, initRepo, runGit } from '../helpers/git-repo.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty directory under the system temp directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-changes-'));
  dirs.push(dir);
  return dir;
}

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
  const head = commitFiles(dir, { 'src/app.ts': 'two\n', 'tests/new.e2e.ts': 'test\n' }, 'feature');
  runGit(dir, 'checkout', '--quiet', 'main');
  const mainTip = commitFiles(dir, { 'docs/later.md': 'later\n' }, 'later');
  runGit(dir, 'checkout', '--quiet', 'feature');
  return { dir, base, head, mainTip };
}

/** `findChanges` in `cwd` with `options` over no flag, an empty environment, and a live signal. */
function lookUp(cwd: string, options: Partial<ChangeOptions> = {}): Promise<ChangeLookup> {
  return findChanges({ cwd, changedSince: undefined, env: {}, signal: new AbortController().signal, ...options });
}

/** The files a lookup found, failing the test when it found none. */
function filesOf(lookup: ChangeLookup): readonly string[] {
  if (lookup.kind !== 'found') throw new Error(`expected a change, got: ${lookup.reason}`);
  return lookup.changes.files;
}

/** What `work` rejected with. */
async function rejection(work: Promise<unknown>): Promise<E2EError> {
  try {
    await work;
  } catch (error) {
    return error as E2EError;
  }
  throw new Error('expected a rejection');
}

/** A GitHub Actions pull request environment, with an event payload naming the `base` and `head` commits when given. */
function pullRequest(commits?: { readonly base?: string; readonly head?: string }, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', ...extra };
  if (commits !== undefined) {
    const eventPath = path.join(tempDir(), 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: commits.base, ref: 'main' }, head: { sha: commits.head, ref: 'feature' } } }));
    env['GITHUB_EVENT_PATH'] = eventPath;
  }
  return env;
}

/** Checks out, detached, the merge of `feature` into `main` that GitHub checks out for a pull request, and returns it. */
function checkOutMerge(dir: string): string {
  runGit(dir, 'checkout', '--quiet', '--detach', 'main');
  runGit(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'feature');
  return runGit(dir, 'rev-parse', 'HEAD');
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
    const lookup = await lookUp(dir, { changedSince: 'main' });
    expect(lookup).toEqual({ kind: 'found', changes: { base, root: realpathSync(dir), files: ['src/app.ts', 'tests/new.e2e.ts'] } });
    if (lookup.kind !== 'found') return;
    expect(Object.isFrozen(lookup.changes)).toBe(true);
    expect(Object.isFrozen(lookup.changes.files)).toBe(true);

    // Asked from a subdirectory, paths stay repository-relative, and untracked files outside it count too.
    expect(filesOf(await lookUp(path.join(dir, 'src'), { changedSince: 'main' }))).toEqual(['src/app.ts', 'tests/new.e2e.ts']);
    writeFileSync(path.join(dir, 'root-new.ts'), 'new\n');
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'new\n');
    expect(filesOf(await lookUp(path.join(dir, 'src'), { changedSince: 'main' }))).toEqual(['root-new.ts', 'src/app.ts', 'src/new.ts', 'tests/new.e2e.ts']);
  });

  it('includes staged, unstaged, deleted, and untracked files, never an ignored one, sorted by code point', async () => {
    const { dir } = featureRepo();
    writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    writeFileSync(path.join(dir, 'staged.ts'), 'new\n');
    runGit(dir, 'add', 'staged.ts');
    writeFileSync(path.join(dir, 'file.txt'), 'edited\n');
    rmSync(path.join(dir, 'src', 'app.ts'));
    writeFileSync(path.join(dir, 'untracked.ts'), 'new\n');
    writeFileSync(path.join(dir, 'Zebra.ts'), 'new\n');
    writeFileSync(path.join(dir, '\u{1F600}.ts'), 'new\n');
    writeFileSync(path.join(dir, '～.ts'), 'new\n');
    mkdirSync(path.join(dir, 'build'));
    writeFileSync(path.join(dir, 'build', 'out.js'), 'ignored\n');
    writeFileSync(path.join(dir, 'build.ts'), 'new\n');
    const files = filesOf(await lookUp(dir, { changedSince: 'main' }));
    expect(files).toEqual(['.gitignore', 'Zebra.ts', 'build.ts', 'file.txt', 'src/app.ts', 'staged.ts', 'tests/new.e2e.ts', 'untracked.ts', '～.ts', '\u{1F600}.ts']);
  });

  it('leaves out an untracked nested repository, which git lists as its directory, and keeps an untracked directory\'s files', async () => {
    const { dir } = featureRepo();
    const nested = path.join(dir, 'tools');
    mkdirSync(nested);
    initRepo(nested);
    mkdirSync(path.join(dir, 'plain'));
    writeFileSync(path.join(dir, 'plain', 'g.txt'), 'new\n');
    expect(filesOf(await lookUp(dir, { changedSince: 'main' }))).toEqual(['plain/g.txt', 'src/app.ts', 'tests/new.e2e.ts']);
  });

  it.skipIf(process.platform === 'win32')('asks git only what git 2.25 knows, as Ubuntu 20.04 ships it', async () => {
    const { dir } = featureRepo();
    // `--no-relative` came in git 2.28: older git prints its usage line and exits 129.
    const bin = tempDir();
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nfor arg; do [ "$arg" = --no-relative ] && { echo 'usage: git diff [<options>] [<commit> [<commit>]] [--] [<path>...]' >&2; exit 129; }; done\nexec ${JSON.stringify(real)} "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
    try {
      expect(filesOf(await lookUp(dir, { changedSince: 'main' }))).toEqual(['src/app.ts', 'tests/new.e2e.ts']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lists both paths of a rename', async () => {
    const { dir } = featureRepo();
    runGit(dir, 'mv', 'file.txt', 'moved.txt');
    commitFiles(dir, {}, 'rename');
    expect(filesOf(await lookUp(dir, { changedSince: 'main' }))).toEqual(['file.txt', 'moved.txt', 'src/app.ts', 'tests/new.e2e.ts']);
  });

  it('has no change to judge when nothing differs, naming the base', async () => {
    const { dir, base } = featureRepo();
    expect(await lookUp(dir, { changedSince: 'HEAD' })).toEqual({
      kind: 'none',
      reason: `no files changed since ${runGit(dir, 'rev-parse', 'HEAD').slice(0, 7)}`,
      warning: false,
      base: runGit(dir, 'rev-parse', 'HEAD'),
    });
    expect(base).not.toBe(runGit(dir, 'rev-parse', 'HEAD'));
  });

  it('wins over a detected pull request', async () => {
    const { dir, mainTip } = featureRepo();
    const head = runGit(dir, 'rev-parse', 'HEAD');
    expect(await lookUp(dir, { env: pullRequest({ base: mainTip }) })).toMatchObject({ kind: 'found' });
    expect(await lookUp(dir, { changedSince: 'HEAD', env: pullRequest({ base: mainTip }) })).toEqual({
      kind: 'none',
      reason: `no files changed since ${head.slice(0, 7)}`,
      warning: false,
      base: head,
    });
  });

  it('is INVALID_CHANGED_SINCE for a ref that names no commit, an option, or one with unrelated history', async () => {
    const { dir } = featureRepo();
    expect(await rejection(lookUp(dir, { changedSince: 'origin/mian' }))).toMatchObject({
      category: 'configuration',
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "origin/mian" names no commit in this checkout',
    });
    for (const ref of ['', '--output=x']) {
      expect(await rejection(lookUp(dir, { changedSince: ref }))).toMatchObject({
        code: 'INVALID_CHANGED_SINCE',
        message: `--changed-since must name a git ref, such as origin/main; got ${JSON.stringify(ref)}`,
      });
    }
    runGit(dir, 'checkout', '--quiet', '--orphan', 'unrelated');
    commitFiles(dir, { 'other.txt': 'x\n' }, 'unrelated');
    runGit(dir, 'checkout', '--quiet', 'feature');
    // A full clone holds every commit: more history cannot help.
    expect(await rejection(lookUp(dir, { changedSince: 'unrelated' }))).toMatchObject({
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "unrelated" shares no history with HEAD: their histories are unrelated; name a ref on the history of HEAD',
    });
  });

  it('is INVALID_CHANGED_SINCE saying to fetch more history when a shallow checkout lacks the merge base', async () => {
    const { dir } = featureRepo();
    const clone = shallowClone(dir, 'feature', 1);
    runGit(clone, 'fetch', '--quiet', '--depth', '1', 'origin', 'main:refs/remotes/origin/main');
    expect(await rejection(lookUp(clone, { changedSince: 'origin/main' }))).toMatchObject({
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "origin/main" shares no history with HEAD in this checkout; fetch more history, such as git fetch --unshallow',
    });
  });

  it('is INVALID_CHANGED_SINCE outside a repository, quoting git, and when git runs out of budget', async () => {
    const outside = tempDir();
    const error = await rejection(lookUp(outside, { changedSince: 'main' }));
    expect(error).toMatchObject({ category: 'configuration', code: 'INVALID_CHANGED_SINCE' });
    expect(error.message).toMatch(/^--changed-since "main": git rev-parse: not a git repository/);

    const { dir } = featureRepo();
    expect(await rejection(lookUp(dir, { changedSince: 'main', budgetMs: 1 }))).toMatchObject({
      code: 'INVALID_CHANGED_SINCE',
      message: '--changed-since "main": git did not answer within 1ms',
    });
  });

  it('rejects INTERRUPTED once the run is interrupted', async () => {
    const { dir } = featureRepo();
    const controller = new AbortController();
    controller.abort();
    expect(await rejection(lookUp(dir, { changedSince: 'main', signal: controller.signal }))).toMatchObject({
      category: 'interrupted',
      code: 'INTERRUPTED',
      message: 'interrupted while finding the change the test filters judge',
    });
  });
});

describe('findChanges on a GitHub Actions pull request', () => {
  it('measures from the base commit the event names, for pull_request and pull_request_target', async () => {
    const { dir, base, mainTip } = featureRepo();
    for (const event of ['pull_request', 'pull_request_target']) {
      const lookup = await lookUp(dir, { env: pullRequest({ base: mainTip }, { GITHUB_EVENT_NAME: event }) });
      expect(lookup).toMatchObject({ kind: 'found', changes: { base, files: ['src/app.ts', 'tests/new.e2e.ts'] } });
    }
  });

  it("prefers the event's base commit to the merge commit's first parent", async () => {
    const { dir, base, head } = featureRepo();
    checkOutMerge(dir);
    expect(await lookUp(dir, { env: pullRequest({ base, head }) })).toMatchObject({
      kind: 'found',
      changes: { base, files: ['docs/later.md', 'src/app.ts', 'tests/new.e2e.ts'] },
    });
  });

  it("falls back to the first parent of GitHub's merge commit, then to origin/<base ref>", async () => {
    const { dir, head, mainTip } = featureRepo();
    const merge = checkOutMerge(dir);
    const missing = 'f'.repeat(40);
    // GitHub's merge commit is known by its second parent, the head the event names, or else by GITHUB_SHA on a pull_request run.
    for (const env of [pullRequest({ base: missing, head }), pullRequest(undefined, { GITHUB_SHA: merge })]) {
      expect(await lookUp(dir, { env })).toMatchObject({ kind: 'found', changes: { base: mainTip, files: ['src/app.ts', 'tests/new.e2e.ts'] } });
    }
    // Without either, or on pull_request_target, whose GITHUB_SHA is the base branch's, a merge commit is not GitHub's.
    for (const env of [pullRequest(), pullRequest(undefined, { GITHUB_SHA: merge, GITHUB_EVENT_NAME: 'pull_request_target' })]) {
      expect(await lookUp(dir, { env })).toMatchObject({ kind: 'none', warning: true });
    }

    // A checkout of the branch head itself is no merge commit: origin/<base> is next.
    const branch = tempDir();
    initRepo(branch);
    const branchPoint = commitFiles(branch, { 'src/app.ts': 'one\n' });
    commitFiles(branch, { 'src/app.ts': 'two\n' });
    expect(await lookUp(branch, { env: pullRequest() })).toMatchObject({
      kind: 'none',
      reason: "could not find the pull request's base commit in the checkout: check out with fetch-depth: 0",
      warning: true,
    });
    runGit(branch, 'update-ref', 'refs/remotes/origin/main', branchPoint);
    expect(await lookUp(branch, { env: pullRequest() })).toMatchObject({ kind: 'found', changes: { base: branchPoint, files: ['src/app.ts'] } });
  });

  it("never takes the first parent of a head checkout whose tip merged the base branch in: that is the pull request's own commit", async () => {
    const { dir, mainTip } = featureRepo();
    runGit(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge main', 'main');
    const tip = runGit(dir, 'rev-parse', 'HEAD');
    runGit(dir, 'checkout', '--quiet', 'main');
    const moved = commitFiles(dir, { 'docs/again.md': 'again\n' }, 'again');
    runGit(dir, 'checkout', '--quiet', 'feature');
    const pullRequestFiles = ['src/app.ts', 'tests/new.e2e.ts'];

    // A checkout of the head with fetch-depth: 2 lacks the base, which moved on since the merge.
    const clone = shallowClone(dir, 'feature', 2);
    for (const event of ['pull_request', 'pull_request_target']) {
      expect(await lookUp(clone, { env: pullRequest({ base: moved, head: tip }, { GITHUB_EVENT_NAME: event }) })).toEqual({
        kind: 'none',
        reason: `could not find the pull request's base commit ${moved.slice(0, 7)} in the checkout: check out with fetch-depth: 0`,
        warning: true,
      });
    }

    // With the base branch in the checkout, origin/<base> measures the pull request's own change.
    runGit(dir, 'update-ref', 'refs/remotes/origin/main', moved);
    const lookup = await lookUp(dir, { env: pullRequest({ base: 'f'.repeat(40), head: tip }) });
    expect(lookup).toMatchObject({ kind: 'found', changes: { base: mainTip, files: pullRequestFiles } });
  });

  it('warns, never fails, when a shallow checkout lacks the base commit, naming it and the fetch-depth that checkout needs', async () => {
    const { dir, head, mainTip } = featureRepo();
    const env = pullRequest({ base: mainTip, head }, { GITHUB_BASE_REF: 'not-fetched' });
    // A checkout of the pull request's head never holds the base, however deep: it needs the base branch.
    for (const depth of [1, 2]) {
      expect(await lookUp(shallowClone(dir, 'feature', depth), { env })).toEqual({
        kind: 'none',
        reason: `could not find the pull request's base commit ${mainTip.slice(0, 7)} in the checkout: check out with fetch-depth: 0`,
        warning: true,
      });
    }

    // GitHub's merge commit one commit deep lacks its first parent; two deep has it.
    runGit(dir, 'update-ref', 'refs/heads/pull-merge', checkOutMerge(dir));
    expect(await lookUp(shallowClone(dir, 'pull-merge', 1), { env })).toEqual({
      kind: 'none',
      reason: `could not find the pull request's base commit ${mainTip.slice(0, 7)} in the checkout: check out with fetch-depth: 2 or more`,
      warning: true,
    });
    expect(await lookUp(shallowClone(dir, 'pull-merge', 2), { env })).toMatchObject({ kind: 'found', changes: { base: mainTip, files: ['src/app.ts', 'tests/new.e2e.ts'] } });
  });

  it('warns when the base shares no history with HEAD, and when git cannot read the checkout', async () => {
    const { dir } = featureRepo();
    runGit(dir, 'checkout', '--quiet', '--orphan', 'unrelated');
    const unrelated = commitFiles(dir, { 'other.txt': 'x\n' }, 'unrelated');
    runGit(dir, 'checkout', '--quiet', 'feature');
    expect(await lookUp(dir, { env: pullRequest({ base: unrelated }) })).toEqual({
      kind: 'none',
      reason: `the pull request's base commit ${unrelated.slice(0, 7)} shares no history with HEAD in the checkout: check out with fetch-depth: 0`,
      warning: true,
    });

    const outside = tempDir();
    const lookup = await lookUp(outside, { env: pullRequest() });
    expect(lookup).toMatchObject({ kind: 'none', warning: true });
    if (lookup.kind === 'none') expect(lookup.reason).toMatch(/^could not read the pull request's change: git rev-parse: not a git repository/);
  });

  it('warns, never fails, when git does not answer within the budget', async () => {
    const { dir, mainTip } = featureRepo();
    expect(await lookUp(dir, { env: pullRequest({ base: mainTip }), budgetMs: 1 })).toEqual({
      kind: 'none',
      reason: "could not read the pull request's change: git did not answer within 1ms",
      warning: true,
    });
  });

  it('judges nothing outside a pull request: a push, a merge queue or merge train, another CI, or a local run', async () => {
    const { dir, mainTip } = featureRepo();
    const mergeTrain = { GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_EVENT_TYPE: 'merge_train', CI_MERGE_REQUEST_DIFF_BASE_SHA: mainTip };
    for (const env of [{}, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' }, mergeTrain, { GITHUB_EVENT_NAME: 'pull_request' }, { CI: 'true', GITHUB_BASE_REF: 'main' }]) {
      expect(await lookUp(dir, { env }), JSON.stringify(env)).toEqual({ kind: 'none', reason: 'not a pull request', warning: false });
    }
    // No git is asked: a directory outside any repository says the same.
    expect(await lookUp(tempDir())).toEqual({ kind: 'none', reason: 'not a pull request', warning: false });
  });
});

describe('findChanges on a GitLab merge request pipeline', () => {
  it('measures from CI_MERGE_REQUEST_DIFF_BASE_SHA, and warns when the checkout lacks it', async () => {
    const { dir, base, mainTip } = featureRepo();
    /** A GitLab merge request pipeline whose diff base is `sha`. */
    const gitlab = (sha: string): NodeJS.ProcessEnv => ({ GITLAB_CI: 'true', CI_MERGE_REQUEST_DIFF_BASE_SHA: sha });
    expect(await lookUp(dir, { env: gitlab(mainTip) })).toMatchObject({ kind: 'found', changes: { base, files: ['src/app.ts', 'tests/new.e2e.ts'] } });
    // A merged results pipeline is a merge request's too; only a merge train is the merge queue.
    for (const type of ['detached', 'merged_result']) {
      expect(await lookUp(dir, { env: { ...gitlab(mainTip), CI_MERGE_REQUEST_EVENT_TYPE: type } }), type).toMatchObject({ kind: 'found' });
    }
    const missing = 'e'.repeat(40);
    expect(await lookUp(dir, { env: gitlab(missing) })).toEqual({
      kind: 'none',
      reason: "could not find the merge request's base commit eeeeeee in the checkout: fetch more history with GIT_DEPTH: 0",
      warning: true,
    });
    expect(await lookUp(dir, { env: { GITLAB_CI: 'true' } })).toEqual({ kind: 'none', reason: 'not a pull request', warning: false });
  });
});
