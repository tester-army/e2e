/**
 * The change a run's test filters judge with `--changed-since <ref>`:
 * every file that differs from where HEAD branched off the ref, in the
 * working tree, untracked files included. A `pull_request_target` run has no
 * change to judge, whatever the flag says. A ref git cannot measure from is
 * `INVALID_CHANGED_SINCE`.
 */

import { execFile } from 'node:child_process';
import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { COMMIT_HASH } from '../internal/git.ts';
import { compareCodePoints } from '../internal/globs.ts';
import { onDiskPath } from '../internal/paths.ts';
import { budgetText } from '../internal/time.ts';
import { ellipsize, shortCommit } from '../report/format.ts';
import type { TestFilterChanges } from '../types.ts';

/** The change to judge, or why there is none; `base` is the merge base when one was found. */
export type ChangeLookup =
  | { readonly kind: 'found'; readonly changes: TestFilterChanges }
  | { readonly kind: 'none'; readonly reason: string; readonly base?: string };

/** What `findChanges` asks git from, and when it gives up. */
export interface ChangeOptions {
  /** The directory git is asked in: the project root. */
  readonly cwd: string;
  /** The base ref `--changed-since` named. */
  readonly changedSince: string;
  /** The run's environment, which says whether this is a `pull_request_target` run. */
  readonly env: NodeJS.ProcessEnv;
  /** The run's interrupt: aborting it rejects with `INTERRUPTED`. */
  readonly signal: AbortSignal;
  /** The most milliseconds every git call together may take; default 30000. */
  readonly budgetMs?: number;
}

/** One git call's exit code and output. */
interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Asks git `args` in `cwd`. */
type Git = (cwd: string, args: readonly string[]) => Promise<GitResult>;

/** Git could not answer: it is missing, printed too much, or failed outright. The message says which. */
class GitFailure extends Error {}

const GIT_BUDGET_MS = 30_000;

/** How much one git call may print: a diff's file list on a large monorepo runs to megabytes. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Why a `pull_request_target` run judges no change: it holds the repository's secrets, and its change may be a fork's, written to talk a model into leaving tests out. */
const PULL_REQUEST_TARGET = 'pull_request_target runs every test';

/**
 * Finds the change the test filters judge: every file that differs from
 * the merge base of `changedSince` and HEAD, in the working tree, untracked
 * files included. A GitHub Actions `pull_request_target` run has none.
 * Every git call together has a 30 second budget; a ref git cannot measure
 * from, in time or at all, is `INVALID_CHANGED_SINCE`.
 */
export async function findChanges(options: ChangeOptions): Promise<ChangeLookup> {
  if (options.env['GITHUB_ACTIONS'] === 'true' && options.env['GITHUB_EVENT_NAME'] === 'pull_request_target') {
    return { kind: 'none', reason: PULL_REQUEST_TARGET };
  }
  const ref = options.changedSince;
  if (ref.length === 0 || ref.startsWith('-')) throw invalidChangedSince(`--changed-since must name a git ref, such as origin/main; got ${JSON.stringify(ref)}`);
  const budgetMs = options.budgetMs ?? GIT_BUDGET_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    return await lookUp(ref, options.cwd, (cwd, args) => runGit(cwd, args, signal));
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

/** The change since `ref`, asking git through `git`. */
async function lookUp(ref: string, cwd: string, git: Git): Promise<ChangeLookup> {
  const root = await repositoryRoot(cwd, git);
  const quoted = JSON.stringify(ref);
  const commit = await commitOf(root, ref, git);
  if (commit === undefined) throw invalidChangedSince(`--changed-since ${quoted} names no commit in this checkout; fetch it, such as with fetch-depth: 0 on actions/checkout`);
  const base = await mergeBase(root, commit, git);
  if (base === undefined) {
    throw invalidChangedSince(
      (await isShallow(root, git))
        ? `--changed-since ${quoted} shares no history with HEAD in this checkout; fetch more history, such as git fetch --unshallow`
        : `--changed-since ${quoted} shares no history with HEAD: their histories are unrelated; name a ref on the history of HEAD`,
    );
  }
  return changesSince(root, base, git);
}

/**
 * Every file in the working tree that differs from `base`, staged or not,
 * and the untracked files, sorted by code point. An untracked nested
 * repository, which git lists as its directory, is not this repository's
 * change.
 */
async function changesSince(root: string, base: string, git: Git): Promise<ChangeLookup> {
  const [diff, untracked] = await Promise.all([
    gitOutput(root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', base, '--'], git),
    gitOutput(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], git),
  ]);
  const files = [...new Set([...diff.split('\0'), ...untracked.split('\0').filter((file) => !file.endsWith('/'))])].filter((file) => file !== '').toSorted(compareCodePoints);
  if (files.length === 0) return { kind: 'none', reason: `no files changed since ${shortCommit(base)}`, base };
  // As on disk, like the filter context's `projectRoot`: git prints `C:/repo` on Windows.
  return { kind: 'found', changes: Object.freeze({ base, root: onDiskPath(root), files: Object.freeze(files) }) };
}

/** The repository `cwd` is in, by its absolute root. */
async function repositoryRoot(cwd: string, git: Git): Promise<string> {
  const root = (await gitOutput(cwd, ['rev-parse', '--show-toplevel'], git)).replace(/\r?\n$/u, '');
  if (root === '') throw new GitFailure('git rev-parse --show-toplevel printed no repository root');
  return root;
}

/** The commit `rev` names in the checkout, or undefined when it names none here. */
async function commitOf(root: string, rev: string, git: Git): Promise<string | undefined> {
  const result = await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const commit = result.stdout.trim();
  return result.exitCode === 0 && COMMIT_HASH.test(commit) ? commit : undefined;
}

/** The merge base of `commit` and HEAD, or undefined when the checkout holds no shared history. */
async function mergeBase(root: string, commit: string, git: Git): Promise<string | undefined> {
  const result = await git(root, ['merge-base', commit, 'HEAD']);
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw new GitFailure(failureText(['merge-base'], result));
  const base = result.stdout.trim();
  return COMMIT_HASH.test(base) ? base : undefined;
}

/** Whether the checkout is shallow, so a missing merge base may be history it has not fetched. */
async function isShallow(root: string, git: Git): Promise<boolean> {
  return (await gitOutput(root, ['rev-parse', '--is-shallow-repository'], git)).trim() === 'true';
}

/** A git call's stdout; a non-zero exit is a `GitFailure` quoting what git said. */
async function gitOutput(cwd: string, args: readonly string[], git: Git): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new GitFailure(failureText(args, result));
  return result.stdout;
}

/** `git rev-parse: not a git repository`: the command and the first line git wrote, without its `fatal:` prefix. */
function failureText(args: readonly string[], result: GitResult): string {
  const said = result.stderr.split('\n').find((line) => line.trim() !== '')?.trim().replace(/^(fatal|error): /u, '');
  return `git ${args[0] ?? ''}: ${ellipsize(said ?? `exited with code ${result.exitCode}`, 200)}`;
}

/**
 * Runs git once: its exit code and output, whatever the code. Git that is
 * missing or prints past the buffer is a `GitFailure`; an abort rejects with
 * the abort, and the caller reads its signals for why.
 */
function runGit(cwd: string, args: readonly string[], signal: AbortSignal): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, signal, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === 'number') {
        resolve({ exitCode: error.code, stdout, stderr });
        return;
      }
      if (signal.aborted) reject(error);
      else if (error.code === 'ENOENT') reject(new GitFailure('git was not found'));
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new GitFailure(`git ${args[0] ?? ''} printed more than ${GIT_MAX_BUFFER / 1024 / 1024} MiB`));
      else reject(new GitFailure(`git ${args[0] ?? ''}: ${error.message}`));
    });
  });
}

/** `--changed-since` named something git cannot measure a change from. */
function invalidChangedSince(message: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError('INVALID_CHANGED_SINCE', message, cause === undefined ? {} : { cause });
}
