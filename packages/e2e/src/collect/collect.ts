/** Collection realm: imports test modules and derives stable identities. */

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { compileGlob, discoverFiles, matchesGlob } from '../internal/globs.ts';
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
  readonly source: SourceLocation | undefined;
  /** Normalized project-root-relative file path with `/` separators. */
  readonly file: string;
  readonly id: string;
  readonly serialId: string | undefined;
}

export interface CollectedTest extends RegisteredTest, TestIdentity {
  /** Outermost serial group, when the test is a serial-group member. */
  readonly serialRoot: GroupNode | undefined;
}

/** Narrows a collected test to its reportable, serializable identity. */
export function testIdentity(test: CollectedTest): TestIdentity {
  return {
    kind: test.kind,
    title: test.title,
    titlePath: test.titlePath,
    declarationIndex: test.declarationIndex,
    sessions: test.sessions,
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
}

export interface Collection {
  readonly files: readonly CollectedFile[];
  readonly tests: readonly CollectedTest[];
  /** Every file the config globs matched, before positionals narrowed it. */
  readonly discovered: readonly string[];
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
    patterns.map((pattern) => {
      const literal: string[] = [];
      for (const segment of pattern.split('/')) {
        if (/[*?]/.test(segment)) break;
        literal.push(segment);
      }
      // A pattern with no glob segment names one file; look beside it.
      if (literal.length === pattern.split('/').length) literal.pop();
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

function toCollectedTests(file: string, registration: ModuleRegistration): CollectedTest[] {
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
}

const GLOB_CHARACTERS = /[*?]/;

/**
 * Narrows the files the config globs discovered by positional arguments. Each
 * positional resolves from the project root and is one of: a glob (any `*` or
 * `?`) in the test glob grammar matched against the discovered files, an
 * existing directory selecting every discovered file beneath it, or a file
 * path matched exactly. Positionals only narrow: a file the config globs did
 * not discover is never selected. Discovery order is preserved.
 */
export function selectPositionals(
  projectRoot: string,
  discovered: readonly string[],
  positionals: readonly string[],
): PositionalSelection {
  if (positionals.length === 0) return { files: discovered, unmatched: [] };
  const selected = new Set<string>();
  const unmatched: string[] = [];
  for (const positional of positionals) {
    const matches = positionalMatcher(projectRoot, positional);
    let matchedAny = false;
    for (const file of discovered) {
      if (!matches(file)) continue;
      selected.add(file);
      matchedAny = true;
    }
    if (!matchedAny) unmatched.push(positional);
  }
  return { files: discovered.filter((file) => selected.has(file)), unmatched };
}

function positionalMatcher(projectRoot: string, positional: string): (file: string) => boolean {
  const normalized = relativeToRoot(projectRoot, positional);
  if (GLOB_CHARACTERS.test(normalized)) {
    // Globs keep the test glob grammar: case-sensitive on every OS.
    const glob = compileGlob(normalized);
    return (file) => matchesGlob(glob, file);
  }
  if (normalized === '.') return () => true;
  const absolutePath = path.resolve(projectRoot, normalized);
  const stats = statSync(absolutePath, { throwIfNoEntry: false });
  if (stats === undefined) return (file) => file === normalized;
  // An existing file or directory follows the filesystem's own case rules.
  const onDisk = onDiskRelativePath(projectRoot, absolutePath) ?? normalized;
  if (stats.isDirectory()) {
    const prefix = `${onDisk}/`;
    return (file) => file.startsWith(prefix);
  }
  return (file) => file === onDisk;
}

/** Builds one CollectedFile from an already-produced registration. */
export function collectFromRegistration(
  projectRoot: string,
  filePath: string,
  registration: ModuleRegistration,
): CollectedFile {
  const file = relativeToRoot(projectRoot, filePath);
  return {
    file,
    absolutePath: path.resolve(projectRoot, file),
    registration,
    tests: toCollectedTests(file, registration),
  };
}

/**
 * A collection made of one registration supplied in memory instead of
 * discovered files: what `e2e explore` runs, whose one test has no file. The
 * virtual file name is what the report and the reporters show for it. Nothing
 * is discovered, so no near miss or unmatched positional can exist.
 */
export function collectInMemory(
  projectRoot: string,
  file: string,
  registration: ModuleRegistration,
): Collection {
  const collected = collectFromRegistration(projectRoot, path.join(projectRoot, file), registration);
  return {
    files: [collected],
    tests: collected.tests,
    discovered: [collected.file],
    nearMisses: [],
    unmatchedPositionals: [],
  };
}

/**
 * Runs collection: resolves globs, sorts matched files by code point, narrows
 * them by any positional arguments, and imports each module once in the
 * collection realm.
 */
export async function collect(
  config: ResolvedConfig,
  positionals: readonly string[] = [],
): Promise<Collection> {
  const discovered = discoverFiles(config.projectRoot, config.tests);
  const { files: matched, unmatched } = selectPositionals(config.projectRoot, discovered, positionals);
  const files: CollectedFile[] = [];
  for (const file of matched) {
    const absolutePath = path.join(config.projectRoot, file);
    let registration: ModuleRegistration;
    try {
      registration = await collectModule(() => importModule(absolutePath, 'collect'));
    } catch (cause) {
      if (cause instanceof CollectionError) throw cause;
      throw new CollectionError(
        `failed to collect ${file}: ${explainModuleError(cause, absolutePath)}`,
        { cause },
      );
    }
    files.push(collectFromRegistration(config.projectRoot, absolutePath, registration));
  }
  return {
    files,
    tests: files.flatMap((file) => file.tests),
    discovered,
    nearMisses: discovered.length === 0 ? findNearMissTestFiles(config.projectRoot, config.tests) : [],
    unmatchedPositionals: unmatched,
  };
}
