/**
 * Module customization hook: the TypeScript a project owns is ESM, whatever
 * the nearest package.json says, and a module graph loaded afresh stays
 * fresh down every path import.
 *
 * Config and tests load through tsx's ESM API. tsx types a `.ts` file by its
 * package scope and hands a CommonJS-scoped one to Node's require, which that
 * API never hooks, so the import fails as "cannot find module" on a path that
 * carries e2e's cache-busting query. Registered before tsx, this hook runs
 * inside tsx's chain: tsx's resolve receives `format: 'module'` from it and
 * transforms the file as ESM. A Next.js app, or any package without
 * `"type": "module"`, keeps its module type.
 *
 * Forced: a file reached by path (the entry file URL, `./helper.ts`, and
 * tsconfig `paths` aliases, which tsx maps to `file:` URLs on every platform
 * before calling this hook), and TypeScript a bare or `#` specifier resolves
 * to outside `node_modules` from a module tsx loads for e2e: a workspace
 * package that exports its `.ts` source, the monorepo pattern, would
 * otherwise hit the same dead end. A module Node loads itself, such as one a
 * `.cjs` helper requires, keeps its format, so Node strips its types; forced
 * to ESM there, nothing would. An installed package under `node_modules`
 * keeps the format its own manifest declares; `.cts` files stay CommonJS.
 *
 * A module imported with the `e2e-graph` query parameter hands it on to every
 * file it reaches by path or `#` import outside `node_modules`, so the project's own graph
 * (a config and the base config or targets file it imports) evaluates afresh
 * with it, while packages stay one shared instance.
 */

import type { ResolveHook, ResolveHookContext, ResolveHookSync } from 'node:module';
import { pathToFileURL } from 'node:url';

type Resolution = ReturnType<ResolveHookSync>;

const TYPESCRIPT_MODULE = /\.(?:ts|mts|tsx)$/;
const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/;
/** A file inside an installed package. */
const INSTALLED = /\/node_modules\//;
/** The tsx namespace e2e registers; tsx tags every URL it loads with it. */
export const TSX_NAMESPACE = 'e2e';
/** The query parameter a fresh module graph carries on every project file. */
const GRAPH_PARAM = 'e2e-graph';

/**
 * How a specifier reaches its file: by path (a relative or absolute path, a
 * `file:` URL, a tsconfig alias tsx mapped to one), through the importing
 * package's own `#` imports, or by a package name.
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

/**
 * The resolution, with TypeScript marked as an ES module when it is reached
 * by path, or is a project file reached any other way from a module tsx
 * loads under e2e's namespace.
 */
export function asModule(specifier: string, context: Pick<ResolveHookContext, 'parentURL'>, resolution: Resolution): Resolution {
  if (resolution.format === 'module' || resolution.format === 'module-typescript') return resolution;
  if (!resolution.url.startsWith('file:') || !TYPESCRIPT_MODULE.test(new URL(resolution.url).pathname)) return resolution;
  const forced =
    reach(specifier) === 'path' ||
    (projectFile(resolution.url) !== undefined && parentParam(context, 'tsx-namespace') === TSX_NAMESPACE);
  return forced ? { ...resolution, format: 'module' } : resolution;
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

/** For `module.registerHooks`. */
export const resolveSync: ResolveHookSync = (specifier, context, nextResolve) =>
  inGraph(specifier, context, asModule(specifier, context, nextResolve(specifier, context)));

/** For `module.register`, which reads this export from the hook module. */
export const resolve: ResolveHook = async (specifier, context, nextResolve) =>
  inGraph(specifier, context, asModule(specifier, context, await nextResolve(specifier, context)));
