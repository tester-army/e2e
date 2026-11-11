/**
 * Rule (c): an engine that starts importing a new `e2e/engine` export
 * counts as raising the floor. This module verifies it: every import a
 * package takes from `e2e` or an `e2e/*` entry must be exported by `e2e`
 * at the version the package's peer floor names, including namespace,
 * side-effect, and default-only imports, which record the subpath even
 * though they name no exports.
 *
 * Imports and exports come from oxc-parser's module info, not pattern
 * matching, so comments and JSDoc examples never count. Declaration
 * kinds come from the parsed declaration: interfaces and type aliases
 * are types only, classes and enums are both, the rest are values.
 *
 * The export set at a version comes from the `e2e@<version>` tag (the
 * entry file off the sibling's `package.json` `exports`, `export *`
 * chains followed). A floor with no tag is unverifiable, not a failure.
 * A value import needs a value export; a type import is satisfied by
 * either kind. Type-only imports count as value imports, since the
 * package's published `.d.ts` names those types.
 */

import { parseSync } from 'oxc-parser';

/** Whether an import takes the name as a value or only as a type. A value import needs a value export; a type import is satisfied by either kind. */
export type ImportKind = 'value' | 'type';

/** The named imports from `e2e` and its subpaths in one source file, keyed by subpath (`''` is the bare `e2e` entry), each name with its kind. A value import of a name subsumes a type import of the same name. */
export type EngineImportMap = ReadonlyMap<string, ReadonlyMap<string, ImportKind>>;

/** The subpath of an `e2e` specifier (`''` for the bare entry), undefined for any other package. */
function e2eSubpath(specifier: string): string | undefined {
  if (specifier === 'e2e') return '';
  if (specifier.startsWith('e2e/')) return specifier.slice('e2e/'.length);
  return undefined;
}

type AstNode = Record<string, unknown>;

function isRecord(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null;
}

/** Parses `source` as a TypeScript module, throwing when oxc-parser reports errors instead of reading a half-parsed file silently. */
function parseModule(source: string): ReturnType<typeof parseSync> {
  const parsed = parseSync('file.ts', source, { lang: 'ts', sourceType: 'module' });
  if (parsed.errors.length > 0) {
    throw new Error(`failed to parse TypeScript source: ${parsed.errors[0]?.message ?? 'unknown parse error'}`);
  }
  return parsed;
}

/** The `exports` key for a subpath (`'.'` for the bare entry). */
function exportKey(subpath: string): string {
  return subpath === '' ? '.' : `./${subpath}`;
}

/** Records `names` into `target`, a value import of a name winning over a type import of the same name. */
function mergeImportKinds(target: Map<string, ImportKind>, names: Iterable<readonly [string, ImportKind]>): void {
  for (const [name, kind] of names) {
    const existing = target.get(name);
    if (existing === undefined || kind === 'value') target.set(name, kind);
  }
}

/** The `import(...)` call in `node`, unwrapping `await` and parentheses; undefined when `node` is not one. */
function importCall(node: unknown): AstNode | undefined {
  let current: unknown = node;
  while (isRecord(current) && (current.type === 'AwaitExpression' || current.type === 'ParenthesizedExpression')) {
    current = current.type === 'AwaitExpression' ? current.argument : current.expression;
  }
  if (!isRecord(current) || current.type !== 'ImportExpression') return undefined;
  return current;
}

/** The source of an `import(...)` call; undefined when `node` is not one. */
function importCallSource(node: unknown): string | undefined {
  const call = importCall(node);
  if (call === undefined) return undefined;
  const source = call.source;
  if (!isRecord(source) || source.type !== 'Literal' || typeof source.value !== 'string') return undefined;
  return source.value;
}

/** The module exports a destructuring pattern reads: the top-level keys of an object pattern, or undefined when the pattern cannot be enumerated (a rest element, a whole-module binding, or anything but an object pattern). A nested pattern reads a property of an export, not another export, so only top-level keys count. */
function patternNames(pattern: unknown): string[] | undefined {
  if (!isRecord(pattern)) return undefined;
  if (pattern.type !== 'ObjectPattern' || !Array.isArray(pattern.properties)) return undefined;
  const names: string[] = [];
  for (const property of pattern.properties) {
    if (!isRecord(property)) return undefined;
    if (property.type !== 'Property') return undefined;
    const key = property.key;
    if (!isRecord(key) || key.type !== 'Identifier' || typeof key.name !== 'string') return undefined;
    names.push(key.name);
  }
  return names;
}

/** Walks every node in `value`, calling `visit` on each object node. */
function walkAst(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) walkAst(child, visit);
}

/** The named imports from `e2e` and its subpaths in one source file, keyed by subpath (`''` is the bare `e2e` entry). A namespace import is recorded as the name `'*'`, which the check cannot enumerate; a side-effect or default-only import records the subpath with no names, so the check still verifies the subpath exists at the floor. */
export function engineImports(source: string): EngineImportMap {
  const found = new Map<string, Map<string, ImportKind>>();
  const add = (subpath: string, names: readonly (readonly [string, ImportKind])[]): void => {
    let map = found.get(subpath);
    if (map === undefined) {
      map = new Map<string, ImportKind>();
      found.set(subpath, map);
    }
    mergeImportKinds(map, names);
  };
  const parsed = parseModule(source);
  for (const statement of parsed.module.staticImports) {
    const subpath = e2eSubpath(statement.moduleRequest.value);
    if (subpath === undefined) continue;
    // Record the subpath even when the import names nothing: a
    // side-effect import (`import 'e2e/engine'`) has no entries, and a
    // default-only import names no export the check tracks, but both
    // still need the subpath to exist at the floor.
    add(subpath, []);
    for (const entry of statement.entries) {
      if (entry.importName.kind === 'NamespaceObject') add(subpath, [['*', 'value']]);
      else if (entry.importName.kind === 'Name' && entry.importName.name !== null) {
        add(subpath, [[entry.importName.name, entry.isType ? 'type' : 'value']]);
      }
    }
  }
  // A re-export from an `e2e` entry is an import too: the package depends
  // on the export existing at its floor. `export * from` cannot be
  // enumerated, so it is recorded as a namespace import.
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const moduleRequest = entry.moduleRequest?.value;
      if (moduleRequest === undefined) continue;
      const subpath = e2eSubpath(moduleRequest);
      if (subpath === undefined) continue;
      add(subpath, []);
      if (entry.importName.kind === 'AllButDefault') add(subpath, [['*', 'value']]);
      else if (entry.importName.kind === 'Name' && entry.importName.name !== null) {
        add(subpath, [[entry.importName.name, entry.isType ? 'type' : 'value']]);
      }
      // `export * as ns` exports one name and imports no names, but the
      // subpath above is still recorded, since the module must exist.
    }
  }
  // A dynamic import takes its names the same way, when they are
  // destructured; any other use cannot be enumerated, so it is recorded as
  // the namespace name, like a namespace import. One walk handles both:
  // a declarator is visited before its `import(...)` child, so the child
  // is skipped once the declarator has recorded it.
  const handled = new Set<object>();
  walkAst(parsed.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const sourceSpecifier = importCallSource(node.init);
      if (sourceSpecifier === undefined) return;
      const subpath = e2eSubpath(sourceSpecifier);
      if (subpath === undefined) return;
      const call = importCall(node.init);
      if (call !== undefined) handled.add(call);
      const names = patternNames(node.id);
      add(
        subpath,
        names === undefined ? [['*', 'value']] : names.map((name): readonly [string, ImportKind] => [name, 'value']),
      );
      return;
    }
    if (node.type !== 'ImportExpression' || handled.has(node)) return;
    const sourceSpecifier = importCallSource(node);
    if (sourceSpecifier === undefined) return;
    const subpath = e2eSubpath(sourceSpecifier);
    if (subpath === undefined) return;
    add(subpath, [['*', 'value']]);
  });
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
    mergeImportKinds(map, names);
  }
}

/** The kind of each name a top-level `export` declaration introduces. Two declarations of one name (interface plus namespace) merge to both. */
function declarationKinds(program: ReturnType<typeof parseSync>['program']): Map<string, 'type' | 'value' | 'both'> {
  const kinds = new Map<string, 'type' | 'value' | 'both'>();
  const set = (name: string, kind: 'type' | 'value' | 'both'): void => {
    const existing = kinds.get(name);
    if (existing === undefined) kinds.set(name, kind);
    else if (existing !== kind) kinds.set(name, 'both');
  };
  const collectBindings = (pattern: unknown): void => {
    if (!isRecord(pattern)) return;
    if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
      set(pattern.name, 'value');
      return;
    }
    if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
      for (const property of pattern.properties) {
        if (!isRecord(property)) continue;
        if (property.type === 'RestElement') collectBindings(property.argument);
        else if (property.type === 'Property') collectBindings(property.value);
      }
      return;
    }
    if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
      for (const element of pattern.elements) collectBindings(element);
      return;
    }
    if (pattern.type === 'AssignmentPattern') collectBindings(pattern.left);
    else if (pattern.type === 'RestElement') collectBindings(pattern.argument);
  };
  for (const statement of program.body) {
    const node: unknown = statement;
    if (!isRecord(node) || node.type !== 'ExportNamedDeclaration') continue;
    const declaration = node.declaration;
    if (!isRecord(declaration)) continue;
    const id = declaration.id;
    const name = isRecord(id) && typeof id.name === 'string' ? id.name : undefined;
    if (declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration') {
      if (name !== undefined) set(name, 'type');
    } else if (declaration.type === 'ClassDeclaration' || declaration.type === 'TSEnumDeclaration') {
      if (name !== undefined) set(name, 'both');
    } else if (declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction' || declaration.type === 'TSModuleDeclaration') {
      if (name !== undefined) set(name, 'value');
    } else if (declaration.type === 'VariableDeclaration' && Array.isArray(declaration.declarations)) {
      for (const declarator of declaration.declarations) {
        if (isRecord(declarator)) collectBindings(declarator.id);
      }
    }
  }
  return kinds;
}

/** The names one file exports, split by kind, and the relative modules its `export *` pulls in. A `type` export or declaration lands in `types`; a class or enum lands in both, since its name is usable as a type; anything else value-like lands in `values`. `export type *` targets are kept apart from value `export *` targets: the former re-export types only. */
function exportedNames(source: string): {
  values: ReadonlySet<string>;
  types: ReadonlySet<string>;
  starModules: readonly string[];
  typeStarModules: readonly string[];
} {
  const parsed = parseModule(source);
  const values = new Set<string>();
  const types = new Set<string>();
  const starModules: string[] = [];
  const typeStarModules: string[] = [];
  const declared = declarationKinds(parsed.program);
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const moduleRequest = entry.moduleRequest?.value;
      if (moduleRequest !== undefined) {
        // `export * as ns` exports only the namespace name, not the
        // module's names, so it is recorded as one export and its star
        // chain is not followed.
        if (entry.importName.kind === 'AllButDefault') {
          (entry.isType ? typeStarModules : starModules).push(moduleRequest);
        } else if (entry.importName.kind === 'All' || entry.importName.kind === 'Name') {
          const name = entry.exportName.name;
          if (name !== null) (entry.isType ? types : values).add(name);
        }
        continue;
      }
      const name = entry.exportName.name;
      if (entry.exportName.kind !== 'Name' || name === null) continue;
      const kind = declared.get(name);
      if (kind === 'type') types.add(name);
      else if (kind === 'both') {
        values.add(name);
        types.add(name);
      } else if (kind === 'value') values.add(name);
      else if (entry.isType) types.add(name);
      else values.add(name);
    }
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
    // A file reached through `export type *` contributes its types only,
    // and a value star reached that way is followed as type-only too.
    for (const name of exported.types) types.add(name);
    if (!typeOnly) {
      for (const name of exported.values) values.add(name);
    }
    const enqueue = (specifier: string, asType: boolean): void => {
      const target = resolveModule(file, specifier);
      if (target !== undefined) queue.push([target, asType]);
    };
    for (const specifier of exported.starModules) enqueue(specifier, typeOnly);
    for (const specifier of exported.typeStarModules) enqueue(specifier, true);
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
  let exports: Record<string, unknown> | undefined;
  try {
    exports = (JSON.parse(packageJson) as { exports?: Record<string, unknown> }).exports;
  } catch {
    return undefined;
  }
  return entryFileFromExports(exports, siblingDir, subpath);
}

/** The entry file for a subpath from an already-parsed `exports` map. */
function entryFileFromExports(exports: Record<string, unknown> | undefined, siblingDir: string, subpath: string): string | undefined {
  const entry = exports?.[exportKey(subpath)];
  const types = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.types === 'string' ? entry.types : undefined;
  if (types === undefined) return undefined;
  return `${siblingDir}/src/${types.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '.ts')}`;
}

/**
 * The export set of a sibling's subpath at a version, split by kind.
 * `readFile` reads a repo path at that version. Undefined when the tag
 * record cannot be read (no manifest, unparseable manifest, unreadable
 * entry). Empty sets when the record exists but the sibling does not
 * export that subpath there: every import from it is then a problem,
 * not unverifiable. An export entry with no types target stays
 * unverifiable, since no entry file can be found for it that way.
 */
export function tagExportsAt(
  readFile: (path: string) => string | undefined,
  siblingDir: string,
  subpath: string,
): ExportSets | undefined {
  const manifest = readFile(`${siblingDir}/package.json`);
  if (manifest === undefined) return undefined;
  let exports: Record<string, unknown> | undefined;
  try {
    exports = (JSON.parse(manifest) as { exports?: Record<string, unknown> }).exports;
  } catch {
    return undefined;
  }
  const entry = entryFileFromExports(exports, siblingDir, subpath);
  if (entry !== undefined) return resolveEntryExports(readFile, entry);
  if (exports?.[exportKey(subpath)] !== undefined) return undefined;
  return { values: new Set<string>(), types: new Set<string>() };
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
 * version, plus the floors that could not be verified. A namespace
 * import is unverifiable, since its names cannot be enumerated, unless
 * the floor tag does not export the subpath at all, which is a problem.
 * A side-effect or default-only import is verified when the tag exports
 * the subpath. `verified` counts the checks whose imports were all
 * checked against a tag record.
 */
export function engineImportProblems(
  checks: readonly EngineImportCheck[],
  exportsAt: (sibling: string, subpath: string, version: string) => ExportSets | undefined,
): { problems: string[]; unverifiable: string[]; verified: number } {
  const problems: string[] = [];
  const unverifiable: string[] = [];
  let verified = 0;
  for (const check of checks) {
    let checked = false;
    let allResolved = true;
    for (const [subpath, names] of check.imports) {
      const label = subpath === '' ? check.sibling : `${check.sibling}/${subpath}`;
      const named = [...names].filter(([name]) => name !== '*');
      if (named.length === 0) {
        // No names to check, but the subpath itself must exist at the
        // floor: a namespace, side-effect, or default-only import from a
        // subpath the floor tag never exported fails at runtime.
        const exported = exportsAt(check.sibling, subpath, check.floor);
        if (exported === undefined) {
          unverifiable.push(`${check.packagePath}: ${label} at ${check.sibling}@${check.floor} cannot be verified, no tag record for that version; the floor must still name a released version`);
          allResolved = false;
        } else if (exported.values.size === 0 && exported.types.size === 0) {
          problems.push(
            `${check.packagePath}: imports from ${label}, but ${check.sibling}@${check.floor} does not export that subpath; a new ${label} import counts as raising the floor, so raise the ${check.sibling} peer floor to the first version that exports it (as a **Breaking:** minor when it passes a runner minor the previous range accepted)`,
          );
        } else if (names.has('*')) {
          unverifiable.push(`${check.packagePath}: ${label} is imported as a namespace, so its names cannot be verified against ${check.sibling}@${check.floor}`);
        } else {
          checked = true;
        }
        continue;
      }
      if (names.has('*')) {
        unverifiable.push(`${check.packagePath}: ${label} is imported as a namespace, so its names cannot be verified against ${check.sibling}@${check.floor}`);
      }
      const exported = exportsAt(check.sibling, subpath, check.floor);
      if (exported === undefined) {
        unverifiable.push(`${check.packagePath}: ${label} at ${check.sibling}@${check.floor} cannot be verified, no tag record for that version; the floor must still name a released version`);
        allResolved = false;
        continue;
      }
      checked = true;
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
    if (checked && allResolved) verified += 1;
  }
  return { problems, unverifiable, verified };
}
