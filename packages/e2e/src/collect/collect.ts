/** Collection realm: imports test modules and derives stable identities. */

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { compileGlob, discoverFiles, GLOB_SYNTAX, literalPrefix, matchesGlob } from '../internal/globs.ts';
import { CollectionError } from '../internal/errors.ts';
import { setupTestId, testId } from '../internal/ids.ts';
import { explainModuleError } from '../config/diagnose.ts';
import { importModule } from '../config/load.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import {
  collectModule,
  groupTitles,
  outermostSerialGroup,
  type GroupNode,
  type ModuleRegistration,
  type RegisteredTest,
  type SourceLocation,
} from './registry.ts';

/**
 * Everything needed to name and report a test, with no executable or realm
 * state attached. Fully JSON-serializable, so it is what result records carry
 * and what crosses the runner<->worker IPC channel.
 */
export interface TestIdentity {
  readonly kind: 'test' | 'setup';
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly declarationIndex: number;
  readonly sessions: readonly string[];
  /** The tags the test declares, outermost describe first, each once; what `--tag` selects on. */
  readonly tags: readonly string[];
  readonly source: SourceLocation | undefined;
  /** Normalized project-root-relative file path with `/` separators. */
  readonly file: string;
  readonly id: string;
  readonly serialId: string | undefined;
}

export interface CollectedTest extends RegisteredTest, TestIdentity {
  /** Outermost serial group, when the test is a serial-group member. */
  readonly serialRoot: GroupNode | undefined;
  /**
   * Whether the positionals selected this test (always, with none): its
   * file, and its declaration line when the file was named as `file:line`.
   * An unselected ordinary test is reported as unselected; an unselected
   * setup test still runs when a selected test consumes its session, which
   * is why the file was collected at all.
   */
  readonly selected: boolean;
}

/** Narrows a collected test to its reportable, serializable identity. */
export function testIdentity(test: CollectedTest): TestIdentity {
  return {
    kind: test.kind,
    title: test.title,
    titlePath: test.titlePath,
    declarationIndex: test.declarationIndex,
    sessions: test.sessions,
    tags: test.tags,
    source: test.source,
    file: test.file,
    id: test.id,
    serialId: test.serialId,
  };
}

export interface CollectedFile {
  readonly file: string;
  readonly absolutePath: string;
  readonly registration: ModuleRegistration;
  readonly tests: readonly CollectedTest[];
  /** Whether the positionals selected this file; a test in it is selected too unless `lines` leaves it out. */
  readonly selected: boolean;
  /**
   * The declaration lines `file:line` positionals named, when every
   * positional that selected the file named one: only the tests declared at
   * those lines are selected. Absent when the file was selected whole.
   */
  readonly lines?: readonly number[];
  /**
   * With `lines`, the lines at which this file itself declares tests, for the
   * `NO_TESTS` message. A test the file registers from a module it imports
   * is declared there, not here, and no line of this file names it.
   */
  readonly declaredLines?: readonly number[];
}

export interface Collection {
  /**
   * Every file the config globs discovered, collected. Positionals mark
   * files `selected` rather than dropping the rest: a setup test that
   * produces a session a selected test consumes runs wherever it lives, so
   * `e2e run login.e2e.ts` works without also naming `auth.setup.e2e.ts`.
   */
  readonly files: readonly CollectedFile[];
  readonly tests: readonly CollectedTest[];
  /**
   * Files that look like tests but match no config glob, gathered only when
   * the globs matched nothing: a `login.test.ts` beside an empty `tests/**`
   * is almost always the file the author meant.
   */
  readonly nearMisses: readonly string[];
  /**
   * Positional arguments, as written, that selected no discovered file. They
   * are not an error on their own: a positional narrows the selection, and
   * the `NO_TESTS` message names them when nothing is left to run.
   */
  readonly unmatchedPositionals: readonly string[];
  /**
   * Files positionals left unselected that failed to collect. Only a narrowed
   * run keeps going past one. A selected test whose session has no setup test
   * gets these files named in its error, since the setup may be in one.
   */
  readonly uncollected: readonly UncollectedFile[];
}

/** A discovered file a narrowed run could not collect, and why. */
export interface UncollectedFile {
  readonly file: string;
  readonly reason: string;
}

/** Suffixes other runners use, and ours with the wrong extension. */
const NEAR_MISS_SUFFIXES = [
  '*.test.ts',
  '*.spec.ts',
  '*.test.js',
  '*.spec.js',
  '*.e2e.js',
  '*.e2e.mjs',
  '*.e2e.mts',
  '*.e2e.cts',
  '*.e2e.tsx',
  '*.e2e-spec.ts',
  '*.e2e.test.ts',
  '*.e2e.spec.ts',
];

/**
 * Test-looking files under the directories the config globs name that no
 * glob matches. The scan stays inside each glob's literal prefix (`tests/`
 * for `tests/**\/*.e2e.ts`), so a repository's unit tests elsewhere are not
 * offered as candidates.
 */
function findNearMissTestFiles(projectRoot: string, patterns: readonly string[]): string[] {
  const compiled = patterns.map(compileGlob);
  const prefixes = new Set(
    compiled.map((glob) => {
      const literal = literalPrefix(glob);
      // A glob with no wildcard names one file; look beside it.
      if (literal.length === glob.segments.length) literal.pop();
      return literal.join('/');
    }),
  );
  const candidates = [...prefixes].flatMap((prefix) =>
    NEAR_MISS_SUFFIXES.map((suffix) => (prefix === '' ? `**/${suffix}` : `${prefix}/**/${suffix}`)),
  );
  return discoverFiles(projectRoot, candidates).filter(
    (file) => !compiled.some((glob) => matchesGlob(glob, file)),
  );
}

/** Derives the serial unit source ID. */
function serialSourceId(file: string, group: GroupNode): string {
  return `serial::${testId(file, groupTitles(group))}`;
}

/**
 * Whether a test's recorded declaration is in the collected module itself,
 * rather than in a module it imports. `captureSource` records the module's
 * own frame when there is one, so the paths agree except for symlinks.
 */
function declaredIn(absolutePath: string, source: SourceLocation | undefined): boolean {
  if (source === undefined) return false;
  return source.file === absolutePath || realPathOf(source.file) === realPathOf(absolutePath);
}

function realPathOf(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

function toCollectedTests(
  file: string,
  absolutePath: string,
  registration: ModuleRegistration,
  selected: boolean,
  lines: readonly number[] | undefined,
): CollectedTest[] {
  const seenTitlePaths = new Set<string>();
  return registration.tests.map((registered) => {
    const encoded = testId(file, registered.titlePath);
    if (seenTitlePaths.has(encoded)) {
      throw new CollectionError(
        `duplicate title path ${registered.titlePath.join(' > ')} in ${file}`,
      );
    }
    seenTitlePaths.add(encoded);
    const serialRoot = outermostSerialGroup(registered.group);
    return {
      ...registered,
      file,
      id: registered.kind === 'setup' ? setupTestId(file, registered.titlePath) : encoded,
      serialRoot,
      serialId: serialRoot === undefined ? undefined : serialSourceId(file, serialRoot),
      selected:
        selected &&
        (lines === undefined || (declaredIn(absolutePath, registered.source) && lines.includes(registered.source!.line))),
    };
  });
}

/**
 * Normalizes an absolute or relative path to the project-root-relative wire
 * form: `/` separators, no `./` prefix or trailing `/`. The project root
 * itself normalizes to `.`. `platformPath` is the host's `path` module; tests
 * pass `path.win32` to exercise drive and UNC semantics on any host.
 */
export function relativeToRoot(
  projectRoot: string,
  filePath: string,
  platformPath: typeof path = path,
): string {
  const relative = platformPath.isAbsolute(filePath)
    ? platformPath.relative(projectRoot, filePath)
    : filePath;
  // On Windows `path.relative` returns the target unchanged when it sits on
  // another drive or UNC share; a result that is still absolute is outside.
  if (platformPath.isAbsolute(relative)) {
    throw new CollectionError(`test file is outside the project root: ${filePath}`);
  }
  const normalized = path.posix.normalize(relative.split(platformPath.sep).join('/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new CollectionError(`test file is outside the project root: ${filePath}`);
  }
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * The root-relative path of an existing entry as the filesystem spells it.
 * Discovery reports directory-listing casing, so on a case-insensitive
 * filesystem (Windows, default macOS) a positional typed in another case
 * must be compared in on-disk casing or it silently matches nothing.
 * Returns undefined when the real path leaves the root (a symlink out of the
 * project), which discovery does not follow either.
 */
function onDiskRelativePath(projectRoot: string, absolutePath: string): string | undefined {
  try {
    const real = realpathSync.native(absolutePath);
    const realRoot = realpathSync.native(projectRoot);
    return relativeToRoot(realRoot, real);
  } catch {
    return undefined;
  }
}

/** Discovered files narrowed by positional arguments, plus the positionals that selected none. */
export interface PositionalSelection {
  readonly files: readonly string[];
  readonly unmatched: readonly string[];
  /**
   * For each selected file that only `file:line` positionals named, the
   * lines they named, in the order given. A file one positional named whole
   * is not here: its tests are all selected.
   */
  readonly lines: ReadonlyMap<string, readonly number[]>;
}

/** `path:line`, the line a positive integer; the path is any positional form. */
const LINE_SUFFIX = /^(.+):([1-9]\d*)$/u;

/**
 * Splits a `file:line` positional. A positional that exists on disk as
 * written is a path even when it ends like one, so a file named `a:1` is
 * still selectable by name.
 */
function splitLine(projectRoot: string, positional: string): { readonly path: string; readonly line: number | undefined } {
  const match = LINE_SUFFIX.exec(positional);
  if (match === null || statSync(path.resolve(projectRoot, positional), { throwIfNoEntry: false }) !== undefined) {
    return { path: positional, line: undefined };
  }
  return { path: match[1]!, line: Number(match[2]) };
}

/**
 * Narrows the files the config globs discovered by positional arguments. Each
 * positional resolves from the project root and is one of: an existing
 * directory selecting every discovered file beneath it, an existing file
 * matched exactly (whatever its name is spelled with), a glob (any wildcard
 * of the test glob grammar, or a form it rejects with a hint) matched against
 * the discovered files, or a name: a positional that exists nowhere selects
 * the discovered files whose root-relative path equals it or ends with it at a
 * segment boundary (`saved-tests.e2e.ts`, `regression/saved-tests.e2e.ts`),
 * and one with no `/` and no `.` selects the files whose base name up to the
 * first `.` equals it (`saved-tests`). Names are exact and case-sensitive,
 * like globs. Any form may end in `:line` (`tests/signup.e2e.ts:12`) to
 * select only the test declared at that line of each file it names.
 * Positionals only narrow: a file the config globs did not discover is never
 * selected. Discovery order is preserved.
 */
export function selectPositionals(
  projectRoot: string,
  discovered: readonly string[],
  positionals: readonly string[],
): PositionalSelection {
  if (positionals.length === 0) return { files: discovered, unmatched: [], lines: new Map() };
  const selected = new Set<string>();
  const whole = new Set<string>();
  const lines = new Map<string, number[]>();
  const unmatched: string[] = [];
  for (const positional of positionals) {
    const { path: named, line } = splitLine(projectRoot, positional);
    const matches = positionalMatcher(projectRoot, named);
    let matchedAny = false;
    for (const file of discovered) {
      if (!matches(file)) continue;
      selected.add(file);
      matchedAny = true;
      if (line === undefined) whole.add(file);
      else lines.set(file, [...(lines.get(file) ?? []), line]);
    }
    if (!matchedAny) unmatched.push(positional);
  }
  for (const file of whole) lines.delete(file);
  return { files: discovered.filter((file) => selected.has(file)), unmatched, lines };
}

function positionalMatcher(projectRoot: string, positional: string): (file: string) => boolean {
  const normalized = relativeToRoot(projectRoot, positional);
  if (normalized === '.') return () => true;
  // An existing entry is a path, whatever its name is spelled with, and
  // follows the filesystem's own case rules.
  const absolutePath = path.resolve(projectRoot, normalized);
  const stats = statSync(absolutePath, { throwIfNoEntry: false });
  if (stats !== undefined) {
    const onDisk = onDiskRelativePath(projectRoot, absolutePath) ?? normalized;
    if (stats.isDirectory()) {
      const prefix = `${onDisk}/`;
      return (file) => file.startsWith(prefix);
    }
    return (file) => file === onDisk;
  }
  if (GLOB_SYNTAX.test(normalized)) {
    // Globs keep the test glob grammar: case-sensitive on every OS.
    const glob = compileGlob(normalized);
    return (file) => matchesGlob(glob, file);
  }
  return nameMatcher(normalized);
}

/**
 * Matches a positional that names no existing entry the way people type file
 * names: the whole root-relative path, a trailing run of its segments, or the
 * base name with every extension dropped when the positional could be one.
 * Mid-segment substrings never match, so `ests/a.e2e.ts` selects nothing.
 */
function nameMatcher(name: string): (file: string) => boolean {
  const suffix = `/${name}`;
  const bareName = !name.includes('/') && !name.includes('.');
  return (file) => {
    if (file === name || file.endsWith(suffix)) return true;
    if (!bareName) return false;
    const base = file.slice(file.lastIndexOf('/') + 1);
    const dot = base.indexOf('.');
    return (dot === -1 ? base : base.slice(0, dot)) === name;
  };
}

/** Builds one CollectedFile from an already-produced registration. */
export function collectFromRegistration(
  projectRoot: string,
  filePath: string,
  registration: ModuleRegistration,
  selected = true,
  lines?: readonly number[],
): CollectedFile {
  const file = relativeToRoot(projectRoot, filePath);
  return {
    file,
    absolutePath: path.resolve(projectRoot, file),
    registration,
    tests: toCollectedTests(file, filePath, registration, selected, lines),
    selected,
    ...(lines === undefined
      ? {}
      : {
          lines,
          declaredLines: registration.tests.flatMap((test) => (declaredIn(filePath, test.source) ? [test.source!.line] : [])),
        }),
  };
}

/**
 * A collection made of one registration supplied in memory instead of
 * discovered files: what `e2e explore` runs, whose one test has no file. The
 * virtual file name is what the report and the reporters show for it. With
 * `setups` (from `collectSetups`), the project's files come first, none of
 * them selected, so the setup test producing a session the registration
 * consumes runs as it would for `e2e run`. No positional is involved, so no
 * near miss or unmatched positional can exist.
 */
export function collectInMemory(
  projectRoot: string,
  file: string,
  registration: ModuleRegistration,
  setups?: Collection,
): Collection {
  const collected = collectFromRegistration(projectRoot, path.join(projectRoot, file), registration);
  const files = [...(setups?.files ?? []), collected];
  return {
    files,
    tests: files.flatMap((entry) => entry.tests),
    nearMisses: [],
    unmatchedPositionals: [],
    uncollected: setups?.uncollected ?? [],
  };
}

/**
 * Collects every file the config globs discover for its setup tests alone:
 * no file is selected, so none of its ordinary tests runs, and a file that
 * fails to collect is kept in `uncollected` rather than failing the run, as
 * a file positionals left out is.
 */
export async function collectSetups(config: ResolvedConfig): Promise<Collection> {
  const discovered = discoverFiles(config.projectRoot, config.tests);
  const { files, uncollected } = await collectFiles(config, discovered, () => false, true, new Map());
  return { files, tests: files.flatMap((entry) => entry.tests), nearMisses: [], unmatchedPositionals: [], uncollected };
}

/**
 * Runs collection: resolves globs, sorts matched files by code point, imports
 * each module once in the collection realm, and records which files any
 * positional arguments selected. Every discovered file is imported even when
 * positionals name a few, because selection needs the whole picture: the
 * setup test a selected test's session depends on may live in a file no
 * positional named. A collection error in a selected file, or anywhere in an
 * unnarrowed run, fails the run; one in a file positionals left out is kept
 * in `uncollected`, so a half-written file elsewhere in the suite does not
 * stop `e2e run tests/one.e2e.ts`.
 */
export async function collect(
  config: ResolvedConfig,
  positionals: readonly string[] = [],
): Promise<Collection> {
  const discovered = discoverFiles(config.projectRoot, config.tests);
  const { files: selectedFiles, unmatched, lines } = selectPositionals(config.projectRoot, discovered, positionals);
  const selected = new Set(selectedFiles);
  const { files, uncollected } = await collectFiles(config, discovered, (file) => selected.has(file), positionals.length > 0, lines);
  return {
    files,
    tests: files.flatMap((file) => file.tests),
    nearMisses: discovered.length === 0 ? findNearMissTestFiles(config.projectRoot, config.tests) : [],
    unmatchedPositionals: unmatched,
    uncollected,
  };
}

/**
 * Imports each discovered file once in the collection realm. A collection
 * error in a selected file, or in any file of a run nothing narrowed, throws;
 * one in a file a narrowed run left unselected is kept in `uncollected`.
 */
async function collectFiles(
  config: ResolvedConfig,
  discovered: readonly string[],
  isSelected: (file: string) => boolean,
  narrowed: boolean,
  lines: ReadonlyMap<string, readonly number[]>,
): Promise<{ files: CollectedFile[]; uncollected: UncollectedFile[] }> {
  const files: CollectedFile[] = [];
  const uncollected: UncollectedFile[] = [];
  for (const file of discovered) {
    const absolutePath = path.join(config.projectRoot, file);
    const skippable = narrowed && !isSelected(file);
    let registration: ModuleRegistration;
    try {
      registration = await collectModule(() => importModule(absolutePath, 'collect'), absolutePath);
    } catch (cause) {
      if (skippable) {
        uncollected.push({ file, reason: cause instanceof CollectionError ? cause.message : explainModuleError(cause, absolutePath) });
        continue;
      }
      // A registration error names the option but not the module it came from.
      if (cause instanceof CollectionError) throw new CollectionError(`${file}: ${cause.message}`, { cause });
      throw new CollectionError(
        `failed to collect ${file}: ${explainModuleError(cause, absolutePath)}`,
        { cause },
      );
    }
    try {
      files.push(collectFromRegistration(config.projectRoot, absolutePath, registration, isSelected(file), lines.get(file)));
    } catch (cause) {
      if (!skippable || !(cause instanceof CollectionError)) throw cause;
      uncollected.push({ file, reason: cause.message });
    }
  }
  return { files, uncollected };
}
