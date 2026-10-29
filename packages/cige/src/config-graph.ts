/**
 * The files a CIGE config reaches, for `e2e-cige diff`, loaded in its own
 * Node process the way `e2e-cige` loads it, so aliases, package exports, and
 * workspace packages resolve as at run time.
 *
 * 1. A resolve hook records every file Node resolves while importing the config.
 * 2. Each listed one is parsed (`imports.ts`) for what loading didn't reach,
 *    such as a lazy `import('#hooks/x')`, resolved by Node without running it.
 *    A file whose imports can't all be read, or that names a repository path
 *    that no longer resolves, blocks.
 * 3. Built output git ignores isn't parsed: its workspace package stands in.
 *    The package's directory counts, so do the workspace packages it depends
 *    on (a bundler may inline them), and its sources join the walk: leniently
 *    inside the package, strictly for what they reach outside every stand-in.
 *    A source the walk can't parse blocks either way.
 *    Untracked output with no package apart from the config's blocks.
 * 4. A symlink to a graph file, or to a directory above one, counts.
 * 5. Each file's nearest package.json counts: its `imports` and `exports` decide where an alias lands.
 * 6. The merge base's config is walked by its relative imports, so a deleted or renamed module counts.
 *
 * Usage: `node --experimental-import-meta-resolve config-graph.js <input.json> <out.json>`.
 * It writes `{ files, packages, manifests, base, unverified }` (repo-relative)
 * to `<out.json>`, never stdout, which belongs to the config. Tests run it
 * from source, so it holds to erasable TypeScript.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { importsOf } from './imports.ts';
import { outside, treeAt, type TreeSide } from './tree.ts';

const INPUT = z.object({
  /** The config to load, absolute, or null when the working tree has none. */
  config: z.string().nullable(),
  root: z.string(),
  mergeBase: z.string(),
  /** Where the config may be, repo-relative, in order. */
  candidates: z.array(z.string()),
  /** Every file git lists in the working tree: tracked and not deleted, and untracked but not ignored. */
  listed: z.array(z.string()),
  /** The listed paths that may be symlinks: tracked as one, retyped in the working tree, or untracked. */
  links: z.array(z.string()),
});

const [inputFile, out] = process.argv.slice(2);
if (inputFile === undefined || out === undefined) throw new Error('usage: config-graph <input.json> <out.json>');
const input = INPUT.parse(JSON.parse(readFileSync(inputFile, 'utf8')));
const root = realpathSync(input.root);
const listed = new Set(input.listed);

const MODULE_EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** A relative specifier, `.` and `..` included. */
const RELATIVE = /^\.{1,2}(?:\/|$)/;

/**
 * The config and the local modules it imports by relative path, at the merge
 * base, from the first candidate the base has. A file that doesn't parse adds
 * nothing: this side only adds what the branch deleted or renamed.
 */
function configModules(candidates: readonly string[], entry: TreeSide): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const found = entry(file);
    if (found === undefined) return;
    seen.add(file);
    // Node imports a symlinked module from its real path, so a link counts (retargeting it is a change) and so does its target.
    if ('target' in found) {
      if (found.target !== undefined) visit(found.target);
      return;
    }
    const imports = importsOf(found.text, file);
    for (const specifier of [...imports.specifiers, ...imports.requires]) {
      if (!RELATIVE.test(specifier)) continue;
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (outside(target)) continue;
      const resolved = MODULE_EXTENSIONS.map((extension) => `${target}${extension}`).find((candidate) => entry(candidate) !== undefined);
      if (resolved !== undefined) visit(resolved);
    }
  };
  const first = candidates.find((file) => entry(file) !== undefined);
  if (first !== undefined) visit(first);
  return [...seen];
}

/** The repo-relative POSIX path of a `file:` URL inside the repository, through any link, else undefined. */
function inRepo(url: string): string | undefined {
  if (!url.startsWith('file:')) return undefined;
  let file: string;
  try {
    file = realpathSync(fileURLToPath(url));
  } catch {
    return undefined;
  }
  const relative = path.relative(root, file).split(path.sep).join('/');
  return relative === '' || outside(relative) || path.isAbsolute(relative) ? undefined : relative;
}

/** A specifier that names a path in this repository, directly or through package.json `imports`; a bare `.` or `..` is a directory's index. */
const LOCAL = /^(?:\.{1,2}(?:\/|$)|\/|#)/;

/** Where an `import` of `specifier` from `file` lands, by ESM resolution; undefined when nothing is there. */
function resolveImport(specifier: string, file: string): string | undefined {
  try {
    const url = import.meta.resolve(specifier, pathToFileURL(file).href);
    // The resolver doesn't check that a relative file exists; loading would.
    return url.startsWith('file:') && !existsSync(fileURLToPath(url)) ? undefined : url;
  } catch {
    return undefined;
  }
}

/** Where a `require` of `specifier` from `file` lands, by CommonJS resolution and its extension search; undefined when nothing is there. */
function resolveRequire(specifier: string, file: string): string | undefined {
  try {
    const resolved = createRequire(file).resolve(specifier);
    // A builtin resolves to its own name.
    return path.isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved;
  } catch {
    return undefined;
  }
}

const MANIFEST = z.looseObject({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
  optionalDependencies: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The directories of the workspace packages a package depends on, in any
 * field, since a bundler may inline a devDependency too; found through
 * `node_modules` as Node finds them. Undefined when the package.json can't be read.
 */
function workspaceDependencies(directory: string): string[] | undefined {
  let manifest: z.infer<typeof MANIFEST>;
  try {
    manifest = MANIFEST.parse(JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')));
  } catch {
    return undefined;
  }
  const names = new Set([manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap((field) => Object.keys(field ?? {})));
  return [...names].flatMap((name) => {
    for (let from = directory; ; from = path.posix.dirname(from)) {
      const linked = path.join(root, from, 'node_modules', name);
      if (existsSync(linked)) {
        const found = inRepo(pathToFileURL(linked).href);
        return found === undefined || installed(found) ? [] : [found];
      }
      if (from === '.') return [];
    }
  });
}

/** Installed packages are reviewed as dependencies, not as the case. */
function installed(file: string): boolean {
  return file.split('/').includes('node_modules');
}

/** The package.json Node reads for a file's `imports` and its package's `exports`: the nearest listed one up to the root. */
function nearestManifest(file: string): string | undefined {
  for (let directory = path.posix.dirname(file); ; directory = path.posix.dirname(directory)) {
    const manifest = directory === '.' ? 'package.json' : `${directory}/package.json`;
    if (listed.has(manifest)) return manifest;
    if (directory === '.') return undefined;
  }
}

const loaded = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    loaded.add(result.url);
    return result;
  },
});

const base = configModules(input.candidates, treeAt(input.mergeBase, root));
const files = new Set<string>();
/** The directories of workspace packages whose sources stand for built output git ignores: a change anywhere under one counts, a deleted file included. */
const packages = new Set<string>();
const unverified: string[] = [];
if (input.config !== null) {
  try {
    await import(pathToFileURL(input.config).href);
  } catch (cause) {
    unverified.push(`loading it failed: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  }
}
if (input.config !== null && unverified.length === 0) {
  const configFile = inRepo(pathToFileURL(input.config).href);
  const ownPackage = configFile === undefined ? undefined : nearestManifest(configFile);
  const ownDirectory = ownPackage === undefined ? undefined : path.posix.dirname(ownPackage);
  // A stand-in's own files are walked leniently, and again strictly if the strict walk reaches one later. What they reach outside every stand-in is walked strictly.
  const strictly = new Set<string>();
  const leniently = new Set<string>();
  const queue: Array<readonly [string, boolean]> = [...loaded]
    .map(inRepo)
    .filter((file): file is string => file !== undefined && !installed(file))
    .map((file) => [file, true] as const);
  // The config's own package never stands in, or its cases and app code would count; what the walk reaches there counts file by file.
  const standIn = (directory: string): void => {
    if (packages.has(directory) || directory === ownDirectory) return;
    packages.add(directory);
    for (const source of listed) if (source.startsWith(`${directory}/`) && !installed(source)) queue.push([source, false]);
    const dependencies = workspaceDependencies(directory);
    if (dependencies === undefined) unverified.push(`${directory}/package.json doesn't parse, so the packages it may bundle aren't known`);
    for (const dependency of dependencies ?? []) standIn(dependency);
  };
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [file, fromStrict] = next;
    const strict = fromStrict || ![...packages].some((directory) => file.startsWith(`${directory}/`));
    if (strictly.has(file) || (!strict && leniently.has(file))) continue;
    (strict ? strictly : leniently).add(file);
    if (!listed.has(file)) {
      const manifest = nearestManifest(file);
      if (manifest === undefined || manifest === 'package.json' || manifest === ownPackage) {
        unverified.push(`loads ${file}, which git doesn't track`);
      } else {
        standIn(path.posix.dirname(manifest));
      }
      continue;
    }
    files.add(file);
    if (!SOURCE.test(file)) continue;
    const imports = importsOf(readFileSync(path.join(root, file), 'utf8'), file);
    // A load a stand-in's sources can't trace is the documented limit; a source the walk can't read at all hides every import it holds.
    const reason = imports.unreadable ?? (strict ? imports.unverified : undefined);
    if (reason !== undefined) unverified.push(`${file} ${reason}`);
    const resolved = [
      ...imports.specifiers.map((specifier) => [specifier, resolveImport(specifier, path.join(root, file))] as const),
      ...imports.requires.map((specifier) => [specifier, resolveRequire(specifier, path.join(root, file))] as const),
    ];
    for (const [specifier, url] of resolved) {
      // A path in this repository that no longer resolves may be a deleted hook a `catch` turns into a pass; a missing package is a dependency's business.
      if (url === undefined) {
        if (strict && LOCAL.test(specifier)) unverified.push(`${file} imports ${specifier}, which doesn't resolve`);
        continue;
      }
      const target = inRepo(url);
      if (target !== undefined && !installed(target)) queue.push([target, strict]);
    }
  }
  // The graph holds real paths, so a link shows only through its target.
  const graph = [...files];
  for (const file of input.links) {
    let link = false;
    try {
      link = lstatSync(path.join(root, file)).isSymbolicLink();
    } catch {
      continue;
    }
    if (!link) continue;
    const target = inRepo(pathToFileURL(path.join(root, file)).href);
    if (target !== undefined && graph.some((reached) => reached === target || reached.startsWith(`${target}/`))) files.add(file);
  }
}
const manifests = new Set([...files].map(nearestManifest).filter((manifest): manifest is string => manifest !== undefined));
writeFileSync(out, JSON.stringify({ files: [...files], packages: [...packages], manifests: [...manifests], base, unverified }));
// The config may leave handles open (a server, a timer); the graph is written, so stop here.
process.exit(0);
