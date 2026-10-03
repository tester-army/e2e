/**
 * e2e's TypeScript loader: synchronous module customization hooks
 * (`module.registerHooks`) that run config, test, and helper TypeScript on
 * Node.js, for `import` and `require` alike.
 *
 * Resolve, for a project file (outside `node_modules`):
 * - a relative or absolute import from TypeScript resolves the way
 *   TypeScript does: `./x.js` to `x.ts` or `x.tsx` (`.mjs` to `.mts`, `.cjs`
 *   to `.cts`), an extensionless `./x` to `x.ts`, `x.tsx`, `x.jsx`, `x.js`,
 *   or `x.json`, and a directory to its index;
 * - a bare specifier the nearest tsconfig.json maps through `paths` or
 *   `baseUrl` resolves to the mapped file, before any package of that name.
 * Everything else, `#` imports and packages included, resolves as Node.js
 * resolves it.
 *
 * Format: `.ts`, `.mts`, and `.tsx` are ES modules wherever they are and
 * whatever the nearest package.json says, so a Next.js app, or any package
 * without `"type": "module"`, keeps its module type and still runs its
 * TypeScript tests; `.cts` is CommonJS. A JSON file imported without
 * `with { type: 'json' }` loads as a module whose default export is the
 * parsed file.
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

const TYPESCRIPT = /\.(?:ts|mts|cts|tsx)$/;
const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/;
/** A URL scheme other than `file:` (`node:`, `data:`, `https:`); never a tsconfig alias. */
const URL_SCHEME = /^[a-z][\d+.a-z-]*:/i;
/** A file inside an installed package. */
const INSTALLED = /\/node_modules\//;
/** The query parameter a fresh module graph carries on every project file. */
const GRAPH_PARAM = 'e2e-graph';
/** Where the helpers compiled code imports live; resolved from e2e's own install, not the project's. */
const RUNTIME_HELPERS = '@oxc-project/runtime/';

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

/**
 * The `file:` URL a project file's import names under TypeScript's rules, or
 * undefined to resolve `specifier` as Node.js does: a path imported from
 * TypeScript (`./x.js`, `./x`, `./dir`), or a bare specifier the importer's
 * tsconfig maps. Installed packages resolve as they were published.
 */
function typeScriptSpecifier(specifier: string, parentURL: string | undefined): string | undefined {
  if (parentURL === undefined || projectFile(parentURL) === undefined) return undefined;
  const cut = specifier.search(/[?#]/);
  const request = cut === -1 ? specifier : specifier.slice(0, cut);
  const suffix = cut === -1 ? '' : specifier.slice(cut);
  let file: string | undefined;
  if (PATH_SPECIFIER.test(request)) {
    if (!TYPESCRIPT.test(new URL(parentURL).pathname)) return undefined;
    const target = fileURLToPath(new URL(request, parentURL));
    file = typeScriptFile(target);
    if (file === target) return undefined;
  } else if (!request.startsWith('#') && !URL_SCHEME.test(request) && !nodeModule.isBuiltin(request)) {
    const candidates = tsconfigFor(fileURLToPath(parentURL))?.paths?.(request) ?? [];
    for (const candidate of candidates) {
      file = typeScriptFile(candidate);
      if (file !== undefined) break;
    }
  }
  return file === undefined ? undefined : `${pathToFileURL(file).href}${suffix}`;
}

/** The format a TypeScript file runs as, or undefined for any other file. */
function typeScriptFormat(pathname: string): ModuleFormat | undefined {
  if (!TYPESCRIPT.test(pathname)) return undefined;
  return pathname.endsWith('.cts') ? 'commonjs' : 'module';
}

/** The resolution, with a TypeScript file's format set to the one the loader compiles it for. */
function withFormat(resolution: Resolution): Resolution {
  if (!resolution.url.startsWith('file:')) return resolution;
  const format = typeScriptFormat(new URL(resolution.url).pathname);
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

export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier.startsWith(RUNTIME_HELPERS)) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
  // A tsconfig alias maps to a file: URL, so it joins a fresh graph like any path.
  const request = typeScriptSpecifier(specifier, context.parentURL) ?? specifier;
  return inGraph(request, context, withFormat(nextResolve(request, context)));
};

export const load: LoadHookSync = (url, context, nextLoad) => {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const { pathname } = new URL(url);
  const format = typeScriptFormat(pathname);
  if (format !== undefined) {
    const file = fileURLToPath(url);
    return { format, source: compileTypeScript(file, readFileSync(file, 'utf8'), format), shortCircuit: true };
  }
  // A require() has no import attributes, whatever the hook types say.
  if (pathname.endsWith('.json') && !context.conditions.includes('require') && context.importAttributes?.type === undefined) {
    const text = readFileSync(fileURLToPath(url), 'utf8').replace(/^﻿/, '');
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
