/**
 * e2e's TypeScript loader: synchronous module customization hooks
 * (`module.registerHooks`) that run config, test, and helper TypeScript and
 * JSX on Node.js, for `import` and `require` alike.
 *
 * Resolve, for a project file (outside `node_modules`):
 * - a relative or absolute import from TypeScript or JSX resolves the way
 *   TypeScript does: `./x.js` to `x.ts` or `x.tsx` (`.mjs` to `.mts`, `.cjs`
 *   to `.cts`), an extensionless `./x` to `x.ts`, `x.tsx`, `x.jsx`, `x.js`,
 *   or `x.json`, and a directory to its index;
 * - a bare specifier the nearest tsconfig.json maps through `paths` or
 *   `baseUrl` resolves to the mapped file, before any package of that name.
 * Everything else, `#` imports and packages included, resolves as Node.js
 * resolves it; when the file an `import` names is missing, the TypeScript
 * file behind it is tried the same way (`#x` mapped to `./x.js`, `./x` from
 * JavaScript).
 *
 * Format: `.ts`, `.mts`, `.tsx`, and `.jsx` are ES modules wherever they are
 * and whatever the nearest package.json says, so a Next.js app, or any
 * package without `"type": "module"`, keeps its module type and still runs
 * its TypeScript tests, whether it is imported or a CommonJS file requires it;
 * `.cts` is CommonJS. A JSON file imported without `with { type: 'json' }`
 * loads as a module whose default export is the parsed file.
 *
 * Freshness: a module imported with the `e2e-graph` query parameter hands it
 * on to every file it reaches by path or `#` import outside `node_modules`,
 * so the project's own graph (a config and the base config or targets file
 * it imports) evaluates afresh with it, while packages stay one shared
 * instance.
 */

import { readFileSync, statSync } from 'node:fs';
import nodeModule, { type LoadHookSync, type ResolveHookContext, type ResolveHookSync } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realmSlot } from '../internal/realm-slot.ts';
import { tsconfigFor } from './tsconfig.ts';
import { compileTypeScript, type ModuleFormat } from './typescript.ts';

type Resolution = ReturnType<ResolveHookSync>;
type NextResolve = Parameters<ResolveHookSync>[2];

/** TypeScript and JSX, which the loader compiles. */
const COMPILED = /\.(?:[cm]?ts|[jt]sx)$/;
const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/;
/** A URL scheme other than `file:` (`node:`, `data:`, `https:`); never a tsconfig alias. */
const URL_SCHEME = /^[a-z][\d+.a-z-]*:/i;
/** A file inside an installed package. */
const INSTALLED = /\/node_modules\//;
/** The query parameter a fresh module graph carries on every project file. */
const GRAPH_PARAM = 'e2e-graph';

/** The TypeScript files a JavaScript extension stands for, in TypeScript's order, then the file itself. */
const TYPESCRIPT_FOR_JAVASCRIPT: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.ts', '.jsx', '.js'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};
/** Tried, in order, after an extensionless path and after a directory's `index`. */
const IMPLIED_EXTENSIONS = ['.ts', '.tsx', '.jsx', '.js', '.json'] as const;

/**
 * How a specifier reaches its file: by path (a relative or absolute path, a
 * `file:` URL, a tsconfig alias the loader mapped to one), through the
 * importing package's own `#` imports, or by a package name.
 */
type Reach = 'path' | 'own-imports' | 'package';

/** How `specifier` reaches its file. */
function reach(specifier: string): Reach {
  if (PATH_SPECIFIER.test(specifier)) return 'path';
  return specifier.startsWith('#') ? 'own-imports' : 'package';
}

/** A file the project owns: a `file:` URL outside `node_modules`. */
function projectFile(url: string): URL | undefined {
  if (!url.startsWith('file:')) return undefined;
  const parsed = new URL(url);
  return INSTALLED.test(parsed.pathname) ? undefined : parsed;
}

/** A query parameter of the importing module's URL. */
function parentParam(context: Pick<ResolveHookContext, 'parentURL'>, name: string): string | null {
  const { parentURL } = context;
  return parentURL?.startsWith('file:') === true ? new URL(parentURL).searchParams.get(name) : null;
}

/**
 * A URL that evaluates `absolutePath` afresh under `key`; with `graph`,
 * every project file it imports by path or `#` import is fresh too.
 */
export function freshModuleURL(absolutePath: string, key: string, graph: boolean): string {
  const url = pathToFileURL(absolutePath);
  url.searchParams.set('e2e', key);
  if (graph) url.searchParams.set(GRAPH_PARAM, key);
  return url.href;
}

function isFile(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The file a TypeScript import of the path `target` names, when it is not
 * `target` itself: the TypeScript file behind a JavaScript extension, the
 * file an extensionless path leaves out, or a directory's index.
 */
function typeScriptFile(target: string): string | undefined {
  const extension = path.extname(target);
  const swaps = TYPESCRIPT_FOR_JAVASCRIPT[extension];
  if (swaps !== undefined) {
    const stem = target.slice(0, -extension.length);
    return swaps.map((swap) => `${stem}${swap}`).find(isFile);
  }
  if (isFile(target)) return target;
  for (const base of [target, path.join(target, 'index')]) {
    const found = IMPLIED_EXTENSIONS.map((implied) => `${base}${implied}`).find(isFile);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A file a specifier names, with the query and hash its URL carried. */
interface Target {
  readonly file: string;
  readonly suffix: string;
}

/**
 * The file a project file's import names under TypeScript's rules, or
 * undefined to resolve `specifier` as Node.js does: a path imported from
 * TypeScript (`./x.js`, `./x`, `./dir`), or a bare specifier the importer's
 * tsconfig maps. Installed packages resolve as they were published.
 */
function typeScriptTarget(specifier: string, parentURL: string | undefined): Target | undefined {
  if (parentURL === undefined || projectFile(parentURL) === undefined) return undefined;
  if (PATH_SPECIFIER.test(specifier)) {
    if (!compiled(parentURL)) return undefined;
    const url = new URL(specifier, parentURL);
    const suffix = `${url.search}${url.hash}`;
    url.search = '';
    url.hash = '';
    const target = fileURLToPath(url);
    const file = typeScriptFile(target);
    return file === undefined || file === target ? undefined : { file, suffix };
  }
  if (specifier.startsWith('#') || URL_SCHEME.test(specifier) || nodeModule.isBuiltin(specifier)) return undefined;
  for (const candidate of tsconfigFor(fileURLToPath(parentURL))?.paths?.(specifier) ?? []) {
    const file = typeScriptFile(candidate);
    if (file !== undefined) return { file, suffix: '' };
  }
  return undefined;
}

/** Whether `context` resolves a `require()`, whose resolver takes paths where `import` takes `file:` URLs. */
function requires(context: Pick<ResolveHookContext, 'conditions'>): boolean {
  return context.conditions.includes('require');
}

/** `target` as a specifier the resolver behind `context` accepts. */
function targetSpecifier(target: Target, context: ResolveHookContext): string {
  return requires(context) ? target.file : `${pathToFileURL(target.file).href}${target.suffix}`;
}

/** Whether `url` is a file the loader compiles. */
function compiled(url: string | undefined): boolean {
  return url?.startsWith('file:') === true && COMPILED.test(new URL(url).pathname);
}

/** The format a compiled file runs as, or undefined for any other file. */
function compiledFormat(pathname: string): ModuleFormat | undefined {
  if (!COMPILED.test(pathname)) return undefined;
  return pathname.endsWith('.cts') ? 'commonjs' : 'module';
}

/** The resolution, with a compiled file's format set to the one the loader compiles it for. */
function withFormat(resolution: Resolution): Resolution {
  if (!resolution.url.startsWith('file:')) return resolution;
  const format = compiledFormat(new URL(resolution.url).pathname);
  return format === undefined || resolution.format === format ? resolution : { ...resolution, format };
}


/**
 * The resolution, joined to its importer's fresh graph: a project file
 * reached by path or by a `#` import from a module that carries
 * `GRAPH_PARAM` carries it too. A package reached by name keeps its shared
 * instance, even a workspace package that resolves outside `node_modules`: a
 * second instance of it would import a second instance of e2e itself.
 */
export function inGraph(specifier: string, context: Pick<ResolveHookContext, 'parentURL'>, resolution: Resolution): Resolution {
  if (reach(specifier) === 'package') return resolution;
  const graph = parentParam(context, GRAPH_PARAM);
  const file = projectFile(resolution.url);
  if (graph === null || file === undefined || file.searchParams.has(GRAPH_PARAM)) return resolution;
  file.searchParams.set(GRAPH_PARAM, graph);
  return { ...resolution, url: file.href };
}

/** Node.js errors for a target that is not there, which carry the target's URL. */
const MISSING_TARGET = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

/**
 * Node.js's resolution of `request`, retried on the TypeScript file behind a
 * target it did not find, for a project file's import: a `#` import or
 * package export naming `./x.js` where `x.ts` is, or an extensionless or
 * directory import from JavaScript.
 */
function resolveOrTypeScript(request: string, context: ResolveHookContext, nextResolve: NextResolve): Resolution {
  try {
    return nextResolve(request, context);
  } catch (error) {
    const { code, url } = error as { code?: unknown; url?: unknown };
    const recoverable =
      typeof code === 'string' && MISSING_TARGET.has(code) && typeof url === 'string' && url.startsWith('file:') &&
      context.parentURL !== undefined && projectFile(context.parentURL) !== undefined;
    const file = recoverable ? typeScriptFile(fileURLToPath(url)) : undefined;
    if (file === undefined) throw error;
    return nextResolve(targetSpecifier({ file, suffix: '' }, context), context);
  }
}

export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  const target = typeScriptTarget(specifier, context.parentURL);
  const request = target === undefined ? specifier : targetSpecifier(target, context);
  const found = resolveOrTypeScript(request, context, nextResolve);
  if (requires(context)) {
    // CommonJS caches modules by file, with no query to make one fresh.
    return withFormat(found);
  }
  const resolution = withFormat(found);
  // A file the loader mapped, a tsconfig alias included, joins a fresh graph like any path.
  return inGraph(target === undefined ? specifier : pathToFileURL(target.file).href, context, resolution);
};

export const load: LoadHookSync = (url, context, nextLoad) => {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const { pathname } = new URL(url);
  const format = compiledFormat(pathname);
  if (format !== undefined) {
    const file = fileURLToPath(url);
    return { format, source: compileTypeScript(file, readFileSync(file, 'utf8'), format), shortCircuit: true };
  }
  // A require() has no import attributes, whatever the hook types say.
  if (pathname.endsWith('.json') && !context.conditions.includes('require') && context.importAttributes?.type === undefined) {
    const text = readFileSync(fileURLToPath(url), 'utf8').replace(/^\uFEFF/, '');
    return { format: 'module', source: `export default JSON.parse(${JSON.stringify(text)});\n`, shortCircuit: true };
  }
  return nextLoad(url, context);
};

/** Marks the process whose module loader already runs these hooks, whichever copy of e2e registered them. */
const registration = realmSlot<true>('e2e.typescript-loader.v1');

/**
 * Registers the hooks once per process, and has stack traces follow the
 * source maps the compiled files carry.
 */
export function registerLoader(): void {
  if (registration.get(globalThis) === true) return;
  registration.set(globalThis, true);
  nodeModule.registerHooks({ resolve, load });
  process.setSourceMapsEnabled(true);
}
