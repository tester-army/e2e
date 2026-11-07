/**
 * How e2e loads a project's modules on Bun. Bun compiles TypeScript and JSX
 * and resolves tsconfig `paths` and `#` imports itself, so e2e registers no
 * module hooks there (`esm-hooks.ts` is the Node.js loader). What Bun lacks
 * is a fresh instance: an import of a `file:` URL ignores the query e2e keys
 * instances by, so a second import of a test file would hand back the first
 * instance, with none of its tests registered again. Instead, e2e deletes the
 * module from Bun's registry, `require.cache` (which holds ES modules too),
 * before it imports the file again.
 *
 * - A load evaluates its file afresh; the files it imports keep their
 *   instance.
 * - A load in a fresh graph also evaluates afresh every project file the
 *   module reaches by path, `#` import, or tsconfig alias that the graph has
 *   not loaded yet: Bun's transpiler lists each file's imports and Bun's
 *   resolver finds them. A package reached by name stays one shared instance.
 *   Bun keeps one instance of each module, so the process holds one graph: a
 *   load in another graph starts it afresh.
 * - Loads run one at a time: each deletes modules from the registry the
 *   others load from.
 *
 * Bun runs an imported module's top level outside its importer's async
 * context, so on Bun nothing that keeps two runs apart by that context runs
 * in one process: `e2e/runner` refuses Bun (`public-ownership.ts`), and
 * `e2e mcp` holds one session (`cli/mcp.ts`).
 */

import { Console } from 'node:console';
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

/** Its `cache` is Bun's module registry: CommonJS and ES modules alike, keyed by real path. */
const bunRequire = nodeModule.createRequire(import.meta.url);

/** The fresh graph the process holds, and the modules it has evaluated. */
let graph: { readonly name: string; readonly loaded: Set<string> } | undefined;

/** The load in progress, which the next one waits for. */
let pending: Promise<unknown> = Promise.resolve();

// Bun's console writes to the terminal itself, past the process.stdout and process.stderr writes e2e redacts and routes.
Object.assign(console, new Console({ stdout: process.stdout, stderr: process.stderr }));

/** Bun's global, which this module is loaded only under. */
function bun(): BunApi {
  return Reflect.get(globalThis, 'Bun') as BunApi;
}

/**
 * Loads `absolutePath` afresh on Bun, as `load.ts`'s `importModule` asks:
 * in the fresh graph `graphName` names, or with the files it imports shared
 * when `graphName` is undefined.
 */
export function importFreshOnBun(absolutePath: string, graphName: string | undefined): Promise<unknown> {
  const load = pending.then(() => loadFresh(absolutePath, graphName));
  pending = load.catch(() => undefined);
  return load;
}

/** Takes the modules the load evaluates afresh out of the registry, imports the file, and records what its graph has loaded once it did. */
async function loadFresh(absolutePath: string, graphName: string | undefined): Promise<unknown> {
  const entry = realPath(absolutePath);
  if (graphName !== undefined && graph?.name !== graphName) graph = { name: graphName, loaded: new Set() };
  const loaded = graphName === undefined ? undefined : graph?.loaded;
  const fresh = loaded === undefined ? [entry] : unloadedModules(entry, loaded);
  for (const id of fresh) delete bunRequire.cache[id];
  const module: unknown = await import(pathToFileURL(entry).href);
  if (loaded !== undefined) for (const id of fresh) loaded.add(id);
  return module;
}

/**
 * The modules a load in a graph evaluates afresh: `entry` itself, and every
 * project module it reaches that the graph has not loaded. A module the
 * graph loaded had what it imports loaded with it, so the search stops there.
 */
function unloadedModules(entry: string, loaded: ReadonlySet<string>): Set<string> {
  const fresh = new Set<string>();
  const queue = [entry];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (fresh.has(id) || (id !== entry && loaded.has(id))) continue;
    fresh.add(id);
    queue.push(...projectImports(id));
  }
  return fresh;
}

/** The project modules the module `id` imports by path, `#` import, or tsconfig alias, as Bun resolves them. */
function projectImports(id: string): string[] {
  // Bun keeps an import's query in the module's identity (`x.ts?v=1`), not in its file.
  const file = id.split('?')[0]!;
  const loader = SCANNED[path.extname(file)];
  if (loader === undefined) return [];
  let imports: readonly { readonly path: string }[];
  try {
    imports = new (bun().Transpiler)({ loader }).scanImports(readFileSync(file, 'utf8'));
  } catch {
    // An unreadable file, or a syntax error the load itself reports.
    return [];
  }
  return imports.flatMap(({ path: specifier }) => projectModule(specifier, file) ?? []);
}

/**
 * The project module `specifier`, written in `importer`, reaches by path,
 * `#` import, or tsconfig alias, as Bun resolves it; undefined for a package,
 * a builtin, a file that is not a module (an addon, an asset), or a specifier
 * Bun cannot resolve, which the load itself reports.
 */
function projectModule(specifier: string, importer: string): string | undefined {
  let resolved: string;
  try {
    resolved = bun().resolveSync(specifier, path.dirname(importer));
  } catch {
    return undefined;
  }
  const file = resolved.split('?')[0]!;
  const extension = path.extname(file);
  if (!path.isAbsolute(file) || INSTALLED.test(file) || (SCANNED[extension] === undefined && extension !== '.json')) return undefined;
  if (isPathSpecifier(specifier, false) || isPathSpecifier(specifier, true) || specifier.startsWith('#')) return resolved;
  return isAlias(specifier, importer, resolved) ? resolved : undefined;
}

/**
 * Whether the tsconfig.json governing `importer` maps the bare `specifier`
 * (`paths`, `baseUrl`) to `resolved`, the module Bun found. Otherwise the
 * specifier names a package, even one whose files sit outside `node_modules`,
 * like a linked workspace package.
 */
function isAlias(specifier: string, importer: string, resolved: string): boolean {
  return (projectView(null).tsconfigFor(importer)?.paths?.(specifier) ?? []).some((candidate) => {
    try {
      return bun().resolveSync(candidate, path.dirname(importer)) === resolved;
    } catch {
      return false;
    }
  });
}

/** `file` with symlinks resolved, as Bun keys its registry; as is when it does not exist, for the import to report. */
function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}
