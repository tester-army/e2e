/**
 * The change a run's test filters judge: every file that differs from where
 * HEAD branched off a base commit. The base comes from `--changed-since`, a
 * GitHub Actions pull request, or a GitLab merge request pipeline; any other
 * run, `pull_request_target` included, has no change to judge. An explicit
 * `--changed-since` git cannot answer is `INVALID_CHANGED_SINCE`; a
 * detected pull or merge request git cannot answer is a warning, never an
 * error.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { COMMIT_HASH } from '../internal/git.ts';
import { compareCodePoints } from '../internal/globs.ts';
import { isPlainObject } from '../internal/options.ts';
import { onDiskPath } from '../internal/paths.ts';
import { budgetText } from '../internal/time.ts';
import { ellipsize, NOT_A_PULL_REQUEST, shortCommit } from '../report/format.ts';
import type { TestFilterChanges } from '../types.ts';

/** The change to judge, or why there is none; `warning` marks a reason the user should fix, `base` the merge base when one was found. */
export type ChangeLookup =
  | { readonly kind: 'found'; readonly changes: TestFilterChanges }
  | { readonly kind: 'none'; readonly reason: string; readonly warning: boolean; readonly base?: string };

/** What `findChanges` asks git from, and when it gives up. */
export interface ChangeOptions {
  /** The directory git is asked in: the project root. */
  readonly cwd: string;
  /** The base ref `--changed-since` named; it wins over what CI says. */
  readonly changedSince: string | undefined;
  /** The run's environment, which says whether this is a pull or merge request. */
  readonly env: NodeJS.ProcessEnv;
  /** The run's interrupt: aborting it rejects with `INTERRUPTED`. */
  readonly signal: AbortSignal;
  /** The most milliseconds every git call together may take; default 30000. */
  readonly budgetMs?: number;
}

/** Where the base commit comes from; a GitHub run's `sha` is `GITHUB_SHA`, the commit the workflow checked out by default. */
type BaseSource =
  | { readonly kind: 'flag'; readonly ref: string }
  | {
      readonly kind: 'github';
      readonly eventPath: string | undefined;
      readonly baseRef: string | undefined;
      readonly sha: string | undefined;
    }
  | { readonly kind: 'gitlab'; readonly sha: string };

/** The commits a GitHub pull request event names, each when its payload holds a full commit hash. */
interface PullRequestCommits {
  readonly base: string | undefined;
  readonly head: string | undefined;
}

/** A request's base commit in the checkout, or the commit it names and how to fetch the history it needs. */
type RequestBase = { readonly commit: string } | { readonly commit: undefined; readonly named: string | undefined; readonly missing: string };

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

/** How a warning names the request, and how to fetch the whole history it may need. */
const REQUESTS = {
  github: { name: "the pull request's", fullHistory: 'check out with fetch-depth: 0' },
  gitlab: { name: "the merge request's", fullHistory: 'fetch more history with GIT_DEPTH: 0' },
} as const;

/** How to check out the first parent of the merge commit GitHub checks out. */
const MERGE_PARENT = 'check out with fetch-depth: 2 or more';

/** Why a `pull_request_target` run judges no change: it holds the repository's secrets, and its change may be a fork's, written to talk a model into leaving tests out. */
const PULL_REQUEST_TARGET = 'pull_request_target runs every test';

/**
 * Finds the change the test filters judge. `--changed-since` wins; then a
 * GitHub Actions `pull_request` run, whose base is the first of the event's
 * `pull_request.base.sha`, the first parent of the merge commit GitHub
 * checks out, and `origin/<GITHUB_BASE_REF>` that is in the checkout; then
 * a GitLab merge request pipeline's `CI_MERGE_REQUEST_DIFF_BASE_SHA`, unless
 * it is a merge train. A `pull_request_target` run has none. The files are
 * what differs from the merge base of that commit and HEAD: for a request,
 * in HEAD, so a file CI writes is not its change; for `--changed-since`, in
 * the working tree, untracked files included. Every git call together has
 * a 30 second budget.
 */
export async function findChanges(options: ChangeOptions): Promise<ChangeLookup> {
  const source = baseSource(options.changedSince, options.env);
  if (source === 'pull_request_target') return { kind: 'none', reason: PULL_REQUEST_TARGET, warning: false };
  if (source === undefined) return { kind: 'none', reason: NOT_A_PULL_REQUEST, warning: false };
  if (source.kind === 'flag' && (source.ref.length === 0 || source.ref.startsWith('-'))) {
    throw invalidChangedSince(`--changed-since must name a git ref, such as origin/main; got ${JSON.stringify(source.ref)}`);
  }
  const budgetMs = options.budgetMs ?? GIT_BUDGET_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    return await lookUp(source, options.cwd, (cwd, args) => runGit(cwd, args, signal));
  } catch (cause) {
    if (options.signal.aborted) {
      throw new E2EError('interrupted', 'INTERRUPTED', 'interrupted while finding the change the test filters judge');
    }
    if (cause instanceof ConfigurationError) throw cause;
    const why = deadline.signal.aborted ? `git did not answer within ${budgetText(budgetMs)}` : cause instanceof GitFailure ? cause.message : String(cause);
    if (source.kind === 'flag') throw invalidChangedSince(`--changed-since ${JSON.stringify(source.ref)}: ${why}`, cause);
    return { kind: 'none', reason: `could not read ${REQUESTS[source.kind].name} change: ${why}`, warning: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Where the run's base commit comes from: the flag, a pull or merge request, or nowhere, as on a merge queue, a merge train, or `pull_request_target`. */
function baseSource(changedSince: string | undefined, env: NodeJS.ProcessEnv): BaseSource | 'pull_request_target' | undefined {
  if (changedSince !== undefined) return { kind: 'flag', ref: changedSince };
  if (env['GITHUB_ACTIONS'] === 'true' && env['GITHUB_EVENT_NAME'] === 'pull_request_target') return 'pull_request_target';
  if (env['GITHUB_ACTIONS'] === 'true' && env['GITHUB_EVENT_NAME'] === 'pull_request') {
    return { kind: 'github', eventPath: env['GITHUB_EVENT_PATH'] || undefined, baseRef: env['GITHUB_BASE_REF'] || undefined, sha: env['GITHUB_SHA'] || undefined };
  }
  // A merge train is GitLab's merge queue: the last gate before the target branch runs every test.
  const sha = env['CI_MERGE_REQUEST_DIFF_BASE_SHA'];
  if (env['GITLAB_CI'] === 'true' && env['CI_MERGE_REQUEST_EVENT_TYPE'] !== 'merge_train' && sha !== undefined && sha !== '') return { kind: 'gitlab', sha };
  return undefined;
}

/** The change from `source`, asking git through `git`. */
async function lookUp(source: BaseSource, cwd: string, git: Git): Promise<ChangeLookup> {
  const root = await repositoryRoot(cwd, git);
  if (source.kind === 'flag') {
    const ref = JSON.stringify(source.ref);
    const commit = await commitOf(root, source.ref, git);
    if (commit === undefined) throw invalidChangedSince(`--changed-since ${ref} names no commit in this checkout`);
    const base = await mergeBase(root, commit, git);
    if (base === undefined) {
      throw invalidChangedSince(
        (await isShallow(root, git))
          ? `--changed-since ${ref} shares no history with HEAD in this checkout; fetch more history, such as git fetch --unshallow`
          : `--changed-since ${ref} shares no history with HEAD: their histories are unrelated; name a ref on the history of HEAD`,
      );
    }
    return changesSince(root, base, git, true);
  }
  const request = REQUESTS[source.kind];
  const found = source.kind === 'github' ? await githubBase(root, source, git) : await gitlabBase(root, source.sha, git);
  if (found.commit === undefined) {
    const sha = found.named === undefined ? '' : ` ${shortCommit(found.named)}`;
    return { kind: 'none', reason: `could not find ${request.name} base commit${sha} in the checkout: ${found.missing}`, warning: true };
  }
  const base = await mergeBase(root, found.commit, git);
  if (base === undefined) {
    return { kind: 'none', reason: `${request.name} base commit ${shortCommit(found.commit)} shares no history with HEAD in the checkout: ${request.fullHistory}`, warning: true };
  }
  return changesSince(root, base, git, false);
}

/**
 * A GitHub pull request's base commit in the checkout: the event's
 * `pull_request.base.sha`, then the first parent of HEAD when HEAD is the
 * merge commit GitHub checks out, then `origin/<GITHUB_BASE_REF>`. A checkout
 * of the pull request's head is no such merge, even when its tip merged the
 * base branch in: that commit's first parent is the pull request's own. The
 * advice for a missing base follows the checkout: a merge commit's first
 * parent comes with one more commit of history, a head checkout needs the
 * base branch too.
 */
async function githubBase(root: string, source: Extract<BaseSource, { kind: 'github' }>, git: Git): Promise<RequestBase> {
  const event = await pullRequestCommits(source.eventPath);
  const fromEvent = event.base === undefined ? undefined : await commitOf(root, event.base, git);
  if (fromEvent !== undefined) return { commit: fromEvent };
  const head = await headCommit(root, git);
  // GitHub's merge commit has the base branch first and the pull request's head second.
  const merge =
    head.parents.length === 2 &&
    (event.head === undefined ? head.commit === source.sha : head.parents[1] === event.head);
  const fromMerge = merge ? await commitOf(root, head.parents[0]!, git) : undefined;
  const commit = fromMerge ?? (source.baseRef === undefined ? undefined : await commitOf(root, `refs/remotes/origin/${source.baseRef}`, git));
  return commit === undefined ? { commit, named: event.base, missing: merge ? MERGE_PARENT : REQUESTS.github.fullHistory } : { commit };
}

/** A GitLab merge request's base commit, `CI_MERGE_REQUEST_DIFF_BASE_SHA`, in the checkout. */
async function gitlabBase(root: string, sha: string, git: Git): Promise<RequestBase> {
  const commit = COMMIT_HASH.test(sha) ? await commitOf(root, sha, git) : undefined;
  return commit === undefined ? { commit, named: sha, missing: REQUESTS.gitlab.fullHistory } : { commit };
}

/**
 * Every file that differs from `base`, sorted by code point: in HEAD, which
 * the change records as its `head`, or with `workingTree` in the working
 * tree, staged or not, and the untracked files. An untracked nested repository, which git lists as its directory,
 * is not this repository's change.
 */
async function changesSince(root: string, base: string, git: Git, workingTree: boolean): Promise<ChangeLookup> {
  const head = workingTree ? undefined : (await gitOutput(root, ['rev-parse', '--verify', 'HEAD'], git)).trim();
  const [diff, untracked] = await Promise.all([
    gitOutput(root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', base, ...(head === undefined ? [] : [head]), '--'], git),
    head === undefined ? gitOutput(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], git) : '',
  ]);
  const files = [...new Set([...diff.split('\0'), ...untracked.split('\0').filter((file) => !file.endsWith('/'))])].filter((file) => file !== '').toSorted(compareCodePoints);
  if (files.length === 0) return { kind: 'none', reason: `no files changed since ${shortCommit(base)}`, warning: false, base };
  // As on disk, like the filter context's `projectRoot`: git prints `C:/repo` on Windows.
  return { kind: 'found', changes: Object.freeze({ base, root: onDiskPath(root), files: Object.freeze(files), ...(head === undefined ? {} : { head }) }) };
}

/** The repository `cwd` is in, by its absolute root. */
async function repositoryRoot(cwd: string, git: Git): Promise<string> {
  const root = (await gitOutput(cwd, ['rev-parse', '--show-toplevel'], git)).replace(/\r?\n$/u, '');
  if (root === '') throw new GitFailure('git rev-parse --show-toplevel printed no repository root');
  return root;
}

/**
 * HEAD's commit and its parents as its own object lists them: a shallow
 * checkout keeps that list though it lacks the parents themselves.
 */
async function headCommit(root: string, git: Git): Promise<{ readonly commit: string; readonly parents: readonly string[] }> {
  const [commit, object] = await Promise.all([gitOutput(root, ['rev-parse', '--verify', 'HEAD'], git), gitOutput(root, ['cat-file', 'commit', 'HEAD'], git)]);
  const header = object.slice(0, Math.max(0, object.indexOf('\n\n')));
  const parents = header.split('\n').flatMap((line) => (line.startsWith('parent ') ? [line.slice('parent '.length).trim()] : []));
  return { commit: commit.trim(), parents };
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

/** The base and head commits a GitHub pull request event names; neither when the payload is missing or unreadable. */
async function pullRequestCommits(eventPath: string | undefined): Promise<PullRequestCommits> {
  if (eventPath === undefined) return { base: undefined, head: undefined };
  try {
    const payload: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
    const pullRequest = isPlainObject(payload) ? payload['pull_request'] : undefined;
    return { base: sideCommit(pullRequest, 'base'), head: sideCommit(pullRequest, 'head') };
  } catch {
    return { base: undefined, head: undefined };
  }
}

/** The pull request's `base.sha` or `head.sha` when it is a full commit hash. */
function sideCommit(pullRequest: unknown, side: 'base' | 'head'): string | undefined {
  const ref = isPlainObject(pullRequest) ? pullRequest[side] : undefined;
  const sha = isPlainObject(ref) ? ref['sha'] : undefined;
  return typeof sha === 'string' && COMMIT_HASH.test(sha) ? sha : undefined;
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
