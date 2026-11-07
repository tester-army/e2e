/**
 * How e2e loads a project's modules on Bun. Bun compiles TypeScript and JSX
 * and resolves tsconfig `paths` and `#` imports itself, so e2e registers no
 * module hooks there (`esm-hooks.ts` is the Node.js loader). What Bun lacks
 * is a fresh instance: it keys a module by its file and ignores the query an
 * import carries, so a second import of a test file would hand back the first
 * instance, with none of its tests registered again. Instead, e2e deletes the
 * module from Bun's registry, `require.cache` (which holds ES modules too),
 * before it loads the file again.
 *
 * - A load evaluates its file afresh; the files it imports keep their
 *   instance.
 * - A load in a fresh graph also evaluates afresh every project file the
 *   module reaches by path, `#` import, or tsconfig alias that the graph has
 *   not loaded yet: Bun's transpiler lists each file's imports and Bun's
 *   resolver finds them. A package reached by name stays one shared instance.
 * - Loads run one at a time: each deletes modules from the registry the
 *   others load from.
 * - A load evaluates the module with `require()`, which Bun runs
 *   synchronously in the caller's async context. Bun runs the top level of an
 *   imported module outside it, where a config's `secrets.get()` and what it
 *   prints would lose the load they belong to. A module that waits on
 *   top-level await cannot be required, and finishes under `import()`.
 *
 * Bun keeps one instance of a file at a time, where Node.js keeps one per
 * graph: two graphs loaded at once share whichever copy of a common project
 * file was evaluated last, and an import whose specifier is computed is not
 * followed into a graph.
 */

import { readFileSync, realpathSync } from 'node:fs';
import nodeModule from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPathSpecifier } from './specifiers.ts';
import { projectView } from './tsconfig.ts';

/** The syntax Bun's transpiler reads each scanned extension's imports with. */
type ScanLoader = 'js' | 'jsx' | 'ts' | 'tsx';

/** The parts of Bun's API the loader uses, so e2e does not depend on Bun's types. */
interface BunApi {
  readonly Transpiler: new (options: { readonly loader: ScanLoader }) => {
    scanImports(code: string): readonly { readonly path: string }[];
  };
  resolveSync(specifier: string, directory: string): string;
}

/** The extensions whose imports a fresh graph follows. */
const SCANNED: Readonly<Record<string, ScanLoader>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

/** A file inside an installed package. */
const INSTALLED = /[\\/]node_modules[\\/]/;

/** Requires a module; its `cache` is Bun's module registry, CommonJS and ES modules alike, keyed by real path. */
const bunRequire = nodeModule.createRequire(import.meta.url);

/** The project files each fresh graph has evaluated, by graph name. */
const graphs = new Map<string, Set<string>>();

/** The load in progress, which the next one waits for. */
let pending: Promise<unknown> = Promise.resolve();

/** Bun's global, which this module is loaded only under. */
function bun(): BunApi {
  return Reflect.get(globalThis, 'Bun') as BunApi;
}

/**
 * Loads `absolutePath` afresh on Bun, as `load.ts`'s `importModule` asks:
 * in the fresh graph `graph` names, or with the files it imports shared when
 * `graph` is undefined.
 */
export function importFreshOnBun(absolutePath: string, graph: string | undefined): Promise<unknown> {
  const load = pending.then(() => loadFresh(absolutePath, graph));
  pending = load.catch(() => undefined);
  return load;
}

/** Takes the files the load evaluates afresh out of the registry, evaluates the module, and records what the graph has loaded once it did. */
async function loadFresh(absolutePath: string, graph: string | undefined): Promise<unknown> {
  const entry = realPath(absolutePath);
  const fresh = graph === undefined ? new Set([entry]) : unloadedFiles(entry, graphs.get(graph));
  for (const file of fresh) delete bunRequire.cache[file];
  const loaded = await evaluate(entry);
  if (graph !== undefined) {
    const known = graphs.get(graph) ?? new Set<string>();
    for (const file of fresh) known.add(file);
    graphs.set(graph, known);
  }
  return loaded;
}

/**
 * The files a load in a graph evaluates afresh: `entry` itself, and every
 * project file it reaches that the graph has not loaded. A file the graph
 * loaded had what it imports loaded with it, so the search stops there.
 */
function unloadedFiles(entry: string, loaded: ReadonlySet<string> | undefined): Set<string> {
  const fresh = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (fresh.has(file) || (file !== entry && loaded?.has(file) === true)) continue;
    fresh.add(file);
    queue.push(...projectImports(file));
  }
  return fresh;
}

/** The project files `file` imports by path, `#` import, or tsconfig alias, as Bun resolves them. */
function projectImports(file: string): string[] {
  const loader = SCANNED[path.extname(file)];
  if (loader === undefined) return [];
  let imports: readonly { readonly path: string }[];
  try {
    imports = new (bun().Transpiler)({ loader }).scanImports(readFileSync(file, 'utf8'));
  } catch {
    // An unreadable file, or a syntax error the load itself reports.
    return [];
  }
  return imports.flatMap(({ path: specifier }) => projectTarget(specifier, file) ?? []);
}

/**
 * The project file `specifier`, written in `importer`, reaches by path, `#`
 * import, or tsconfig alias, as Bun resolves it; undefined for a package, a
 * builtin, a file that is not a module (an addon, an asset), or a specifier
 * Bun cannot resolve, which the load itself reports.
 */
function projectTarget(specifier: string, importer: string): string | undefined {
  let resolved: string;
  try {
    resolved = bun().resolveSync(specifier, path.dirname(importer));
  } catch {
    return undefined;
  }
  const extension = path.extname(resolved);
  if (!path.isAbsolute(resolved) || INSTALLED.test(resolved) || (SCANNED[extension] === undefined && extension !== '.json')) return undefined;
  if (isPathSpecifier(specifier, false) || isPathSpecifier(specifier, true) || specifier.startsWith('#')) return resolved;
  return isAliasOf(specifier, importer, resolved) ? resolved : undefined;
}

/**
 * Whether the tsconfig.json governing `importer` maps the bare `specifier`
 * (`paths`, `baseUrl`) to `resolved`, the file Bun found: a candidate as
 * written, with an extension added or swapped (`x` or `x.js` for `x.ts`), or
 * its directory's index. Otherwise the specifier names a package, even one
 * whose files sit outside `node_modules`, like a linked workspace package.
 */
function isAliasOf(specifier: string, importer: string, resolved: string): boolean {
  const stem = (file: string): string => file.slice(0, file.length - path.extname(file).length);
  return (projectView(null).tsconfigFor(importer)?.paths?.(specifier) ?? []).some((written) => {
    const candidate = realPath(written);
    return resolved === candidate || stem(resolved) === stem(candidate) || stem(resolved) === path.join(candidate, 'index');
  });
}

/**
 * Evaluates `file` with `require()`, in the caller's async context; a module
 * that waits on top-level await finishes under `import()`, which continues
 * the evaluation `require()` started instead of running it again.
 */
async function evaluate(file: string): Promise<unknown> {
  try {
    return bunRequire(file);
  } catch (error) {
    if (!awaitsAtTopLevel(error)) throw error;
    return import(pathToFileURL(file).href);
  }
}

/** Whether `error` is Bun refusing to require a module that waits on top-level await (Node.js's `ERR_REQUIRE_ASYNC_MODULE`). */
function awaitsAtTopLevel(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'ERR_REQUIRE_ASYNC_MODULE') return true;
  return error instanceof Error && error.message.startsWith('require() async module ');
}

/** `file` with symlinks resolved, as Bun keys its registry; for a file that does not exist, its directory resolved, else `file` as is. */
function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return file;
    }
  }
}
