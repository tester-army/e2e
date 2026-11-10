/**
 * Rule (c) of #1657: an engine that starts importing a new `e2e/engine`
 * export counts as raising the floor. This module verifies it: for each
 * package, every named import it takes from `e2e` or an `e2e/*` entry must
 * be exported by `e2e` at the version the package's peer floor names.
 *
 * The export set at a version comes from the tag record,
 * `e2e@<version>`: the entry file is read off the sibling's `package.json`
 * `exports` at that tag (its `types` target, mapped from `dist/` to
 * `src/`), and `export *` chains are followed. The tag record is the only
 * source that names the version's exports exactly: the CHANGELOG records
 * releases but not exports, and the published tarball would put the
 * network in `pnpm check`. A floor whose tag does not exist (for example
 * `e2e@0.15.0`, released before a tag was cut per version) cannot be
 * verified this way; that floor is reported as unverifiable, not as a
 * failure, and the released-floor rule in `peer-ranges.ts` still applies
 * to it. Type-only imports count the same as value imports: the package's
 * published `.d.ts` names those types, so a consumer on the floor runner
 * fails typecheck when the floor version lacks them.
 *
 * Only imports from `e2e` itself are checked. An integration's imports
 * from another engine (`@e2e-dev/web`, `@e2e-dev/mobile`) are the same
 * shape but a different sibling, and the maintainer's rule names
 * `e2e/engine`; extending this to engine peers is a follow-up, not part
 * of this change.
 */

export type EngineImportMap = ReadonlyMap<string, ReadonlySet<string>>;

const IMPORT_FROM = /import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s+from\s+['"]e2e(\/[^'"]*)?['"]/gs;
const REEXPORT_FROM = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]e2e(\/[^'"]*)?['"]/gs;
const NAMESPACE_FROM = /import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s+['"]e2e(\/[^'"]*)?['"]/g;

/** The named imports from `e2e` and its subpaths in one source file, keyed by subpath (`''` is the bare `e2e` entry). A namespace import is recorded as the name `'*'`, which the check cannot enumerate. */
export function engineImports(source: string): EngineImportMap {
  const found = new Map<string, Set<string>>();
  const add = (subpath: string, names: readonly string[]): void => {
    let set = found.get(subpath);
    if (set === undefined) {
      set = new Set<string>();
      found.set(subpath, set);
    }
    for (const name of names) set.add(name);
  };
  const splitNames = (list: string): string[] =>
    list
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, ''))
      .filter((part) => part.length > 0)
      .map((part) => part.split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((part) => part.length > 0);
  for (const pattern of [IMPORT_FROM, REEXPORT_FROM]) {
    for (const match of source.matchAll(pattern)) {
      const list = match[1];
      const subpath = (match[2] ?? '').replace(/^\//, '');
      if (list === undefined) continue;
      add(subpath, splitNames(list));
    }
  }
  for (const match of source.matchAll(NAMESPACE_FROM)) {
    add((match[1] ?? '').replace(/^\//, ''), ['*']);
  }
  return found;
}

/** The names one file exports, and the relative modules its `export *` pulls in. */
function exportedNames(source: string): { names: ReadonlySet<string>; starModules: readonly string[] } {
  const names = new Set<string>();
  const starModules: string[] = [];
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+['"]([^'"]+)['"])?/gs)) {
    const list = match[1];
    if (list === undefined) continue;
    for (const part of list.split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '');
      if (trimmed.length === 0) continue;
      const nameMatch = /(\w+)(?:\s+as\s+(\w+))?/.exec(trimmed);
      if (nameMatch === null) continue;
      names.add(nameMatch[2] ?? nameMatch[1] ?? '');
    }
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\*\s*(?:as\s+\w+\s*)?from\s+['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) starModules.push(match[1]);
  }
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:interface|type|class|function|const|let|var|enum|abstract\s+class)\s+(\w+)/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return { names, starModules };
}

/** Resolves a relative module specifier against the file that imports it; undefined for a bare specifier. */
export function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const parts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * The export set of the entry file, following `export *` chains.
 * `readFile` reads a repo path (undefined when it has none); the caller
 * binds it to a version, for example `git show <tag>:<path>`.
 */
export function resolveEntryExports(readFile: (path: string) => string | undefined, entryPath: string): ReadonlySet<string> | undefined {
  const exported = new Set<string>();
  const seen = new Set<string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFile(file);
    if (source === undefined) return undefined;
    const { names, starModules } = exportedNames(source);
    for (const name of names) exported.add(name);
    for (const specifier of starModules) {
      const target = resolveModule(file, specifier);
      if (target !== undefined) queue.push(target);
    }
  }
  return exported;
}

/**
 * The source file for a sibling's subpath entry, from the sibling's
 * `package.json` (`exports` `types` target, mapped from `dist/` to
 * `src/`). `subpath` is `''` for the bare entry. Undefined when the
 * package has no such export, or its manifest does not parse.
 */
export function subpathEntryFile(packageJson: string, siblingDir: string, subpath: string): string | undefined {
  let parsed: { exports?: Record<string, { types?: string } | string> };
  try {
    parsed = JSON.parse(packageJson) as { exports?: Record<string, { types?: string } | string> };
  } catch {
    return undefined;
  }
  const entry = parsed.exports?.[subpath === '' ? '.' : `./${subpath}`];
  const types = typeof entry === 'string' ? entry : entry?.types;
  if (typeof types !== 'string') return undefined;
  return `${siblingDir}/src/${types.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '.ts')}`;
}

/**
 * The export set of a sibling's subpath at a version, read through
 * `showFile(tag, path)`. Undefined when the tag, the manifest, or the
 * entry cannot be read.
 */
export function tagExportsAt(
  showFile: (tag: string, path: string) => string | undefined,
  tag: string,
  siblingDir: string,
  subpath: string,
): ReadonlySet<string> | undefined {
  const manifest = showFile(tag, `${siblingDir}/package.json`);
  if (manifest === undefined) return undefined;
  const entry = subpathEntryFile(manifest, siblingDir, subpath);
  if (entry === undefined) return undefined;
  return resolveEntryExports((path) => showFile(tag, path), entry);
}

export interface EngineImportCheck {
  readonly packageName: string;
  readonly packagePath: string;
  readonly sibling: string;
  readonly floor: string;
  readonly imports: EngineImportMap;
}

/**
 * Every import in `checks` the sibling does not export at the floor
 * version, plus the floors that could not be verified. `exportsAt`
 * returns the sibling's export set for a subpath at a version, or
 * undefined when that version has no tag record to read; an unverifiable
 * floor is a note, not a problem, since the released-floor rule still
 * applies to it. A namespace import is unverifiable for the same reason:
 * its names cannot be enumerated.
 */
export function engineImportProblems(
  checks: readonly EngineImportCheck[],
  exportsAt: (sibling: string, subpath: string, version: string) => ReadonlySet<string> | undefined,
): { problems: string[]; unverifiable: string[] } {
  const problems: string[] = [];
  const unverifiable: string[] = [];
  for (const check of checks) {
    for (const [subpath, names] of check.imports) {
      const label = subpath === '' ? check.sibling : `${check.sibling}/${subpath}`;
      if (names.has('*')) {
        unverifiable.push(`${check.packagePath}: ${label} is imported as a namespace, so its names cannot be verified against ${check.sibling}@${check.floor}`);
        continue;
      }
      const exported = exportsAt(check.sibling, subpath, check.floor);
      if (exported === undefined) {
        unverifiable.push(`${check.packagePath}: ${label} at ${check.sibling}@${check.floor} cannot be verified, no tag record for that version; the floor must still name a released version`);
        continue;
      }
      const missing = [...names].filter((name) => !exported.has(name)).toSorted();
      if (missing.length > 0) {
        problems.push(
          `${check.packagePath}: imports ${missing.map((name) => `\`${name}\``).join(', ')} from ${label}, but ${check.sibling}@${check.floor} does not export ${missing.length === 1 ? 'it' : 'them'}; a new ${label} import counts as raising the floor, so raise the ${check.sibling} peer floor to the first version that exports ${missing.length === 1 ? 'it' : 'them'} (as a **Breaking:** minor when it passes a runner minor the previous range accepted)`,
        );
      }
    }
  }
  return { problems, unverifiable };
}
