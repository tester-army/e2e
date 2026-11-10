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
 * fails typecheck when the floor version lacks them. The split runs the
 * other way too: a value import needs a value export, so a name that only
 * reaches the entry through `export type *` (for example `isKeyModifier`
 * from `contract.ts`, which `e2e/engine` does not export as a value) does
 * not satisfy a value import. Imports and exports are therefore tracked by
 * kind: `value` or `type`. A type import is satisfied by a value or a type
 * export; a value import only by a value export.
 *
 * Only imports from `e2e` itself are checked. An integration's imports
 * from another engine (`@e2e-dev/web`, `@e2e-dev/mobile`) are the same
 * shape but a different sibling, and the maintainer's rule names
 * `e2e/engine`; extending this to engine peers is a follow-up, not part
 * of this change.
 */

/** Whether an import takes the name as a value or only as a type. A value import needs a value export; a type import is satisfied by either kind. */
export type ImportKind = 'value' | 'type';

/** The named imports from `e2e` and its subpaths in one source file, keyed by subpath (`''` is the bare `e2e` entry), each name with its kind. A value import of a name subsumes a type import of the same name. */
export type EngineImportMap = ReadonlyMap<string, ReadonlyMap<string, ImportKind>>;

const IMPORT_FROM = /import\s+(type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s+from\s+['"]e2e(\/[^'"]*)?['"]/gs;
const REEXPORT_FROM = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]e2e(\/[^'"]*)?['"]/gs;
const NAMESPACE_FROM = /import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s+['"]e2e(\/[^'"]*)?['"]/g;

/** The named imports from `e2e` and its subpaths in one source file, keyed by subpath (`''` is the bare `e2e` entry). A namespace import is recorded as the name `'*'`, which the check cannot enumerate. */
export function engineImports(source: string): EngineImportMap {
  const found = new Map<string, Map<string, ImportKind>>();
  const add = (subpath: string, names: readonly (readonly [string, ImportKind])[]): void => {
    let map = found.get(subpath);
    if (map === undefined) {
      map = new Map<string, ImportKind>();
      found.set(subpath, map);
    }
    for (const [name, kind] of names) {
      const existing = map.get(name);
      if (existing === undefined || kind === 'value') map.set(name, kind);
    }
  };
  const splitNames = (list: string, wholeListType: boolean): [string, ImportKind][] =>
    list
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part): [string, ImportKind] => {
        const typeOnly = wholeListType || part.startsWith('type ');
        const name = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '';
        return [name, typeOnly ? 'type' : 'value'];
      })
      .filter(([name]) => name.length > 0);
  for (const pattern of [IMPORT_FROM, REEXPORT_FROM]) {
    for (const match of source.matchAll(pattern)) {
      const list = match[2];
      const subpath = (match[3] ?? '').replace(/^\//, '');
      if (list === undefined) continue;
      add(subpath, splitNames(list, match[1] !== undefined));
    }
  }
  for (const match of source.matchAll(NAMESPACE_FROM)) {
    add((match[1] ?? '').replace(/^\//, ''), [['*', 'value']]);
  }
  return found;
}

/** Merges `source` into `target`, a value import of a name winning over a type import of the same name. */
export function addEngineImports(target: Map<string, Map<string, ImportKind>>, source: EngineImportMap): void {
  for (const [subpath, names] of source) {
    let map = target.get(subpath);
    if (map === undefined) {
      map = new Map<string, ImportKind>();
      target.set(subpath, map);
    }
    for (const [name, kind] of names) {
      const existing = map.get(name);
      if (existing === undefined || kind === 'value') map.set(name, kind);
    }
  }
}

/** The names one file exports, split by kind, and the relative modules its `export *` pulls in. A `type` export or declaration lands in `types`; a class or enum lands in both, since its name is usable as a type; anything else value-like lands in `values`. `export type *` targets are kept apart from value `export *` targets: the former re-export types only. */
function exportedNames(source: string): {
  values: ReadonlySet<string>;
  types: ReadonlySet<string>;
  starModules: readonly string[];
  typeStarModules: readonly string[];
} {
  const values = new Set<string>();
  const types = new Set<string>();
  const starModules: string[] = [];
  const typeStarModules: string[] = [];
  for (const match of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s+['"]([^'"]+)['"])?/gs)) {
    const wholeListType = match[1] !== undefined;
    const list = match[2];
    if (list === undefined) continue;
    for (const part of list.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const typeOnly = wholeListType || trimmed.startsWith('type ');
      const nameMatch = /(\w+)(?:\s+as\s+(\w+))?/.exec(trimmed.replace(/^type\s+/, ''));
      if (nameMatch === null) continue;
      const name = nameMatch[2] ?? nameMatch[1] ?? '';
      if (name.length === 0) continue;
      (typeOnly ? types : values).add(name);
    }
  }
  for (const match of source.matchAll(/export\s+(type\s+)?\*\s*(?:as\s+\w+\s*)?from\s+['"]([^'"]+)['"]/g)) {
    if (match[2] !== undefined) (match[1] !== undefined ? typeStarModules : starModules).push(match[2]);
  }
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(interface|type|class|function|const|let|var|enum|abstract\s+class)\s+(\w+)/g)) {
    const kind = match[1];
    const name = match[2];
    if (kind === undefined || name === undefined) continue;
    if (kind === 'interface' || kind === 'type') types.add(name);
    else if (kind === 'class' || kind === 'enum' || kind.startsWith('abstract')) {
      values.add(name);
      types.add(name);
    } else values.add(name);
  }
  return { values, types, starModules, typeStarModules };
}

/** The names an entry exports, split by kind. */
export interface ExportSets {
  readonly values: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
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
 * The export set of the entry file, split by kind, following `export *`
 * chains. A file reached through `export type *` contributes its types
 * only: a function or const there has no type meaning to re-export.
 * `readFile` reads a repo path (undefined when it has none); the caller
 * binds it to a version, for example `git show <tag>:<path>`.
 */
export function resolveEntryExports(readFile: (path: string) => string | undefined, entryPath: string): ExportSets | undefined {
  const values = new Set<string>();
  const types = new Set<string>();
  const seen = new Set<string>();
  const queue: [string, boolean][] = [[entryPath, false]];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) continue;
    const [file, typeOnly] = next;
    const key = `${file}:${typeOnly ? 'type' : 'value'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = readFile(file);
    if (source === undefined) return undefined;
    const exported = exportedNames(source);
    if (typeOnly) {
      for (const name of exported.types) types.add(name);
      for (const specifier of [...exported.starModules, ...exported.typeStarModules]) {
        const target = resolveModule(file, specifier);
        if (target !== undefined) queue.push([target, true]);
      }
    } else {
      for (const name of exported.values) values.add(name);
      for (const name of exported.types) types.add(name);
      for (const specifier of exported.starModules) {
        const target = resolveModule(file, specifier);
        if (target !== undefined) queue.push([target, false]);
      }
      for (const specifier of exported.typeStarModules) {
        const target = resolveModule(file, specifier);
        if (target !== undefined) queue.push([target, true]);
      }
    }
  }
  return { values, types };
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
 * The export set of a sibling's subpath at a version, split by kind, read
 * through `showFile(tag, path)`. Undefined when the tag, the manifest, or
 * the entry cannot be read.
 */
export function tagExportsAt(
  showFile: (tag: string, path: string) => string | undefined,
  tag: string,
  siblingDir: string,
  subpath: string,
): ExportSets | undefined {
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
 * its names cannot be enumerated. A namespace import does not excuse the
 * names imported beside it from the same subpath: those are still
 * validated. A value import needs a value export; a type import is
 * satisfied by a value or a type export.
 */
export function engineImportProblems(
  checks: readonly EngineImportCheck[],
  exportsAt: (sibling: string, subpath: string, version: string) => ExportSets | undefined,
): { problems: string[]; unverifiable: string[] } {
  const problems: string[] = [];
  const unverifiable: string[] = [];
  for (const check of checks) {
    for (const [subpath, names] of check.imports) {
      const label = subpath === '' ? check.sibling : `${check.sibling}/${subpath}`;
      const named = [...names].filter(([name]) => name !== '*');
      if (names.has('*')) {
        unverifiable.push(`${check.packagePath}: ${label} is imported as a namespace, so its names cannot be verified against ${check.sibling}@${check.floor}`);
      }
      if (named.length === 0) continue;
      const exported = exportsAt(check.sibling, subpath, check.floor);
      if (exported === undefined) {
        unverifiable.push(`${check.packagePath}: ${label} at ${check.sibling}@${check.floor} cannot be verified, no tag record for that version; the floor must still name a released version`);
        continue;
      }
      const missing = named
        .filter(([name, kind]) => (kind === 'value' ? !exported.values.has(name) : !exported.values.has(name) && !exported.types.has(name)))
        .map(([name]) => name)
        .toSorted();
      if (missing.length > 0) {
        problems.push(
          `${check.packagePath}: imports ${missing.map((name) => `\`${name}\``).join(', ')} from ${label}, but ${check.sibling}@${check.floor} does not export ${missing.length === 1 ? 'it' : 'them'}; a new ${label} import counts as raising the floor, so raise the ${check.sibling} peer floor to the first version that exports ${missing.length === 1 ? 'it' : 'them'} (as a **Breaking:** minor when it passes a runner minor the previous range accepted)`,
        );
      }
    }
  }
  return { problems, unverifiable };
}
