/**
 * Whether a run's test filters are called, and on which tests: the one gate
 * `run` and `list` share. A `--last-failed` rerun's tests are owed and never
 * judged. Without a change to judge, or when a lockfile or the config file
 * changed, no filter is called and every test runs. A test whose file, or
 * its session's setup file, changed runs without one, as when either's
 * stored screenshots changed.
 */

import path from 'node:path';
import { onDiskPath } from '../internal/paths.ts';
import { collapseText } from '../internal/text.ts';
import type { ReportChanges } from '../report/build.ts';
import { ellipsize, shortCommit } from '../report/format.ts';
import { plural } from '../report/markdown-text.ts';
import type { TestFilterCandidate, TestFilterChanges } from '../types.ts';
import { findChanges } from './changes.ts';

/** What the gate decides from. */
export interface FilterGateInput {
  /** The tests the selection runs, as the filters would be handed them. */
  readonly candidates: readonly TestFilterCandidate[];
  /** Whether this is a `--last-failed` rerun, whose tests are owed. */
  readonly lastFailed: boolean;
  /** The base ref `--changed-since` named. */
  readonly changedSince: string | undefined;
  readonly projectRoot: string;
  /** The config file the run loaded; undefined for a config value. */
  readonly configPath: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  /** One line about what the gate decided. */
  readonly notice: (message: string) => void;
}

/** The gate's decision: the tests the filters judge and the change they judge, or neither, and the report's record of it. */
export interface FilterGate {
  /** The tests the filters are handed; empty when no filter is called. */
  readonly candidates: readonly TestFilterCandidate[];
  /** The change the filters judge; undefined when no filter is called. */
  readonly changes: TestFilterChanges | undefined;
  /** What `run.changes` records. */
  readonly record: ReportChanges;
}

/** The most code points `run.changes.skipped` keeps. */
const MAX_SKIPPED = 1024;

/** Lockfiles of every package manager, and Gradle's version catalog, by name at any depth: a change to one can change what any test does. */
const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Podfile.lock',
  'Package.resolved',
  'Cartfile.resolved',
  'gradle.lockfile',
  'buildscript-gradle.lockfile',
  'libs.versions.toml',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'pdm.lock',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'pubspec.lock',
  'mix.lock',
  'packages.lock.json',
  'flake.lock',
  'MODULE.bazel.lock',
]);

/** What ends the directory of a test file's stored screenshots, `<test file>-snapshots/`. */
const SNAPSHOTS = '-snapshots/';

/**
 * Decides whether the filters are called, in order: never on a
 * `--last-failed` rerun (git is not asked), nor with no test to judge, nor
 * without a change, nor when a lockfile or the loaded config file changed.
 * Otherwise a candidate whose test file or session's setup file changed,
 * or a stored screenshot of either, runs without a filter, which runs a
 * changed setup too; the rest
 * are judged. Each decision is one notice; a pull request the checkout
 * cannot measure is a warning.
 */
export async function gateTestFilters(input: FilterGateInput): Promise<FilterGate> {
  /** No filter is called, for `record.skipped`, said as `message` or `<why>, so no filter ran`. */
  const skip = (record: ReportChanges & { readonly skipped: string }, message = `${record.skipped}, so no filter ran`): FilterGate => {
    input.notice(message);
    return { candidates: [], changes: undefined, record };
  };
  if (input.lastFailed) return skip({ files: 0, skipped: '--last-failed' }, '--last-failed: the tests the last run owes run without filters');
  if (input.candidates.length === 0) return skip({ files: 0, skipped: 'no tests to judge' });
  const lookup = await findChanges({ cwd: input.projectRoot, changedSince: input.changedSince, env: input.env, signal: input.signal });
  if (lookup.kind === 'none') {
    const record = { ...(lookup.base === undefined ? {} : { base: lookup.base }), files: 0, skipped: lookup.reason };
    return skip(record, lookup.warning ? `warning: no filter ran: ${lookup.reason}` : undefined);
  }
  const { changes } = lookup;
  // Git names files in NFC, while a test file's name keeps the bytes on disk, NFD where macOS wrote them.
  const changed = new Set(changes.files.map((file) => file.normalize('NFC')));
  const inRepository = repositoryPath(changes.root, input.projectRoot);
  const configFile = input.configPath === undefined ? undefined : inRepository(input.configPath);
  const everything = changes.files.find((file) => LOCKFILES.has(path.posix.basename(file)) || file.normalize('NFC') === configFile);
  const counts = { base: changes.base, files: changes.files.length };
  if (everything !== undefined) return skip({ ...counts, skipped: ellipsize(collapseText(`${everything} changed`), MAX_SKIPPED) });
  const screenshotted = snapshotOwners(changed);
  /** Whether `file`, project-relative or absolute, or one of its stored screenshots, is one the change holds. */
  const touched = (file: string | undefined): boolean => {
    if (file === undefined) return false;
    const inRepo = inRepository(file);
    return changed.has(inRepo) || screenshotted.has(inRepo);
  };
  const judged = input.candidates.filter((candidate) => !touched(candidate.file) && !touched(candidate.setupFile));
  const pinned = input.candidates.length - judged.length;
  const record = { ...counts, ...(pinned === 0 ? {} : { pinned }) };
  const pinnedLine = `${plural(pinned, 'test')} ${pinned === 1 ? 'runs' : 'run'} without filters: ${pinned === 1 ? 'its' : 'their'} test file, screenshots, or setup file changed`;
  if (judged.length === 0) {
    input.notice(pinnedLine);
    return skip({ ...record, skipped: 'no tests left to judge' });
  }
  input.notice(`judging ${plural(changes.files.length, 'file')} changed since ${shortCommit(changes.base)}`);
  if (pinned > 0) input.notice(pinnedLine);
  return { candidates: Object.freeze(judged), changes, record };
}

/** The test files, repository-relative, whose stored screenshots `changed` holds one of. */
function snapshotOwners(changed: ReadonlySet<string>): ReadonlySet<string> {
  const owners = new Set<string>();
  for (const file of changed) {
    for (let at = file.indexOf(SNAPSHOTS); at !== -1; at = file.indexOf(SNAPSHOTS, at + 1)) owners.add(file.slice(0, at));
  }
  return owners;
}

/**
 * Maps a path, project-relative or absolute, to the repository-relative
 * POSIX path `changes.files` holds, in NFC. Both roots are spelled as on
 * disk first, symlinks resolved and in on-disk case, as git spells its own,
 * and composed before they are compared.
 */
function repositoryPath(root: string, projectRoot: string): (file: string) => string {
  const realRoot = onDiskPath(root).normalize('NFC');
  const project = onDiskPath(projectRoot).normalize('NFC');
  return (file) => {
    const absolute = (path.isAbsolute(file) ? onDiskPath(file) : path.join(project, file)).normalize('NFC');
    return path.relative(realRoot, absolute).split(path.sep).join('/');
  };
}
