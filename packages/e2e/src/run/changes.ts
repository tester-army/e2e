/**
 * The change a run's test filters judge with `--changed-since <ref>`:
 * every file that differs from where HEAD branched off the ref, in the
 * working tree, untracked files included. A ref git cannot measure from is
 * `INVALID_CHANGED_SINCE`.
 */

import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { COMMIT_HASH, GitFailure, runGit, type GitResult } from '../internal/git.ts';
import { compareCodePoints } from '../internal/globs.ts';
import { onDiskPath } from '../internal/paths.ts';
import { budgetText } from '../internal/time.ts';
import { ellipsize } from '../report/format.ts';
import type { TestFilterChanges } from '../types.ts';

/** What `findChanges` asks git from, and when it gives up. */
interface ChangeOptions {
  /** The directory git is asked in: the project root. */
  readonly cwd: string;
  /** The base ref `--changed-since` named. */
  readonly changedSince: string;
  /** The run's interrupt: aborting it rejects with `INTERRUPTED`. */
  readonly signal: AbortSignal;
  /** The most milliseconds every git call together may take; default 30000. */
  readonly budgetMs?: number;
}

const GIT_BUDGET_MS = 30_000;

/** How much one git call may print: a diff's file list on a large monorepo runs to megabytes. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Finds the change the test filters judge: every file that differs from
 * the merge base of `changedSince` and HEAD, in the working tree, untracked
 * files included, sorted; `files` is empty when nothing changed. Every git
 * call together has a 30 second budget; a ref git cannot measure from, in
 * time or at all, is `INVALID_CHANGED_SINCE`.
 */
export async function findChanges(options: ChangeOptions): Promise<TestFilterChanges> {
  const ref = options.changedSince;
  const budgetMs = options.budgetMs ?? GIT_BUDGET_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    return await lookUp(ref, options.cwd, signal);
  } catch (cause) {
    if (options.signal.aborted) {
      throw new E2EError('interrupted', 'INTERRUPTED', 'interrupted while finding the change the test filters judge');
    }
    if (cause instanceof ConfigurationError) throw cause;
    const why = deadline.signal.aborted ? `git did not answer within ${budgetText(budgetMs)}` : cause instanceof GitFailure ? cause.message : String(cause);
    throw invalidChangedSince(`--changed-since ${JSON.stringify(ref)}: ${why}`, cause);
  } finally {
    clearTimeout(timer);
  }
}

/** The change since `ref`, asking git within `signal`. */
async function lookUp(ref: string, cwd: string, signal: AbortSignal): Promise<TestFilterChanges> {
  const root = await repositoryRoot(cwd, signal);
  const quoted = JSON.stringify(ref);
  const commit = await commitOf(root, ref, signal);
  if (commit === undefined) throw invalidChangedSince(`--changed-since ${quoted} names no commit in this checkout; fetch it, such as with fetch-depth: 0 on actions/checkout or GIT_DEPTH: 0 on GitLab`);
  const base = await mergeBase(root, commit, signal);
  if (base === undefined) {
    throw invalidChangedSince(
      (await isShallow(root, signal))
        ? `--changed-since ${quoted} shares no history with HEAD in this checkout; fetch more history, such as git fetch --unshallow`
        : `--changed-since ${quoted} shares no history with HEAD: their histories are unrelated; name a ref on the history of HEAD`,
    );
  }
  return changesSince(root, base, signal);
}

/**
 * Every file in the working tree that differs from `base`, staged or not,
 * and the untracked files, sorted by code point. An untracked nested
 * repository, which git lists as its directory, is not this repository's
 * change.
 */
async function changesSince(root: string, base: string, signal: AbortSignal): Promise<TestFilterChanges> {
  const [diff, untracked] = await Promise.all([
    gitOutput(root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', base, '--'], signal),
    gitOutput(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], signal),
  ]);
  const files = [...new Set([...diff.split('\0'), ...untracked.split('\0').filter((file) => !file.endsWith('/'))])].filter((file) => file !== '').toSorted(compareCodePoints);
  // As on disk, like the filter context's `projectRoot`: git prints `C:/repo` on Windows.
  return Object.freeze({ base, root: onDiskPath(root), files: Object.freeze(files) });
}

/** The repository `cwd` is in, by its absolute root. */
async function repositoryRoot(cwd: string, signal: AbortSignal): Promise<string> {
  const root = (await gitOutput(cwd, ['rev-parse', '--show-toplevel'], signal)).replace(/\r?\n$/u, '');
  if (root === '') throw new GitFailure('git rev-parse --show-toplevel printed no repository root');
  return root;
}

/**
 * The commit `rev` names in the checkout, or undefined when it names none
 * here. The object is found first and peeled after, so a rev whose syntax
 * takes the rest of the text, as `:/message` does, is not handed `^{commit}`.
 */
async function commitOf(root: string, rev: string, signal: AbortSignal): Promise<string | undefined> {
  const found = await runGit(root, ['rev-parse', '--verify', '--quiet', rev], { signal, maxBuffer: GIT_MAX_BUFFER });
  const object = found.stdout.trim();
  if (found.exitCode !== 0 || !COMMIT_HASH.test(object)) return undefined;
  const peeled = await runGit(root, ['rev-parse', '--verify', '--quiet', `${object}^{commit}`], { signal, maxBuffer: GIT_MAX_BUFFER });
  const commit = peeled.stdout.trim();
  return peeled.exitCode === 0 && COMMIT_HASH.test(commit) ? commit : undefined;
}

/** The merge base of `commit` and HEAD, or undefined when the checkout holds no shared history. */
async function mergeBase(root: string, commit: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runGit(root, ['merge-base', commit, 'HEAD'], { signal, maxBuffer: GIT_MAX_BUFFER });
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw new GitFailure(failureText(['merge-base'], result));
  const base = result.stdout.trim();
  return COMMIT_HASH.test(base) ? base : undefined;
}

/** Whether the checkout is shallow, so a missing merge base may be history it has not fetched. */
async function isShallow(root: string, signal: AbortSignal): Promise<boolean> {
  return (await gitOutput(root, ['rev-parse', '--is-shallow-repository'], signal)).trim() === 'true';
}

/** A git call's stdout; a non-zero exit is a `GitFailure` quoting what git said. */
async function gitOutput(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  const result = await runGit(cwd, args, { signal, maxBuffer: GIT_MAX_BUFFER });
  if (result.exitCode !== 0) throw new GitFailure(failureText(args, result));
  return result.stdout;
}

/** `git rev-parse: not a git repository`: the command and the first line git wrote, without its `fatal:` prefix. */
function failureText(args: readonly string[], result: GitResult): string {
  const said = result.stderr.split('\n').find((line) => line.trim() !== '')?.trim().replace(/^(fatal|error): /u, '');
  return `git ${args[0] ?? ''}: ${ellipsize(said ?? `exited with code ${result.exitCode}`, 200)}`;
}

/** `--changed-since` named something git cannot measure a change from. */
function invalidChangedSince(message: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError('INVALID_CHANGED_SINCE', message, cause === undefined ? {} : { cause });
}
