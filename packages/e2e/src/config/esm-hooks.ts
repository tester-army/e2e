/**
 * e2e's TypeScript loader: synchronous module customization hooks
 * (`module.registerHooks`) that run config, test, and helper TypeScript and
 * JSX on Node.js, for `import` and `require` alike. `compiled-files.ts` says
 * which files it compiles and which tsconfig.json governs them.
 *
 * Resolve: an import written in a compiled file follows TypeScript's rules;
 * every other import, JavaScript's included, resolves as Node.js resolves it.
 * - A relative or absolute path: `./x.js` names `x.ts`, `x.tsx`, or `x.jsx`
 *   when one exists (`./x.mjs` names `x.mts`, `./x.cjs` names `x.cts`), an
 *   extensionless `./x` names `x.ts`, `x.tsx`, `x.jsx`, `x.js`, or `x.json`,
 *   and a directory names its index the same way.
 * - A bare specifier the project's tsconfig.json maps through `paths` or
 *   `baseUrl` names the mapped file, before any package of that name.
 * - A `#` import or package export that names a missing `./x.js` (or `.mjs`,
 *   `.cjs`) names the TypeScript file behind it, for an `import`.
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
 * instance. The graph's tsconfig.json and file lookups are its own too
 * (`tsconfig.ts`).
 *
 * This module, and everything it imports from e2e, is loaded by Node.js's
 * own type stripping when a worker runs from source (`register.ts`), so it
 * holds to erasable TypeScript: no enums, namespaces, or parameter
 * properties.
 */

import nodeModule, { type LoadHookSync, type ResolveHookContext, type ResolveHookSync } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InfrastructureError } from '../internal/errors.ts';
import { unsupportedNodeMessage } from '../internal/node-version.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { compiledSource, IMPLIED_EXTENSIONS, isProjectFile, writtenCandidates, type CompiledSource } from './compiled-files.ts';
import { projectView, type ProjectView } from './tsconfig.ts';
import { compileTypeScript } from './typescript.ts';

type Resolution = ReturnType<ResolveHookSync>;
type NextResolve = Parameters<ResolveHookSync>[2];

const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/;
/** A URL scheme other than `file:` (`node:`, `data:`, `https:`); never a tsconfig alias. */
const URL_SCHEME = /^[a-z][\d+.a-z-]*:/i;
/** The query parameter a fresh module graph carries on every project file. */
const GRAPH_PARAM = 'e2e-graph';

/**
 * How a specifier reaches its file: by path (a relative or absolute path, a
 * `file:` URL, a tsconfig alias the loader mapped to a file), through the
 * importing package's own `#` imports, or by a package name.
 */
type Reach = 'path' | 'own-imports' | 'package';

/** How `specifier`, as written, reaches its file. */
function reach(specifier: string): Reach {
  if (PATH_SPECIFIER.test(specifier)) return 'path';
  return specifier.startsWith('#') ? 'own-imports' : 'package';
}

/** The `e2e-graph` value of a module URL: the fresh graph it belongs to, or null. */
function graphOf(url: string | undefined): string | null {
  return url?.startsWith('file:') === true ? new URL(url).searchParams.get(GRAPH_PARAM) : null;
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

/** The first of `candidates` that is a file. */
function firstFile(candidates: readonly string[], view: ProjectView): string | undefined {
  return candidates.find((candidate) => view.isFile(candidate));
}

/** The TypeScript file behind `target`'s written extension (`x.ts` for `x.js`), or the file as written. */
function swappedFile(target: string, view: ProjectView): string | undefined {
  const extension = path.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  return firstFile(writtenCandidates(extension).map((candidate) => `${stem}${candidate}`), view);
}

/**
 * The file an import of the path `target` names under TypeScript's rules:
 * the TypeScript file behind a written extension, the file itself, the file
 * an extensionless path leaves out, or a directory's index.
 */
function typeScriptFile(target: string, view: ProjectView): string | undefined {
  if (writtenCandidates(path.extname(target)).length > 0) return swappedFile(target, view);
  if (view.isFile(target)) return target;
  for (const base of [target, path.join(target, 'index')]) {
    const found = firstFile(IMPLIED_EXTENSIONS.map((implied) => `${base}${implied}`), view);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A file an import names, with the query and hash its URL carried. */
interface Target {
  readonly file: string;
  readonly suffix: string;
}

/**
 * The file an import written in `importer` names under TypeScript's rules,
 * when that is not what Node.js would resolve: a path (`./x.js`, `./x`,
 * `./dir`), or a bare specifier the project's tsconfig maps.
 */
function typeScriptTarget(specifier: string, importer: CompiledSource, view: ProjectView): Target | undefined {
  if (PATH_SPECIFIER.test(specifier)) {
    const url = new URL(specifier, pathToFileURL(importer.file));
    const suffix = `${url.search}${url.hash}`;
    url.search = '';
    url.hash = '';
    const target = fileURLToPath(url);
    const file = typeScriptFile(target, view);
    return file === undefined || file === target ? undefined : { file, suffix };
  }
  if (!importer.project || specifier.startsWith('#') || URL_SCHEME.test(specifier) || nodeModule.isBuiltin(specifier)) return undefined;
  for (const candidate of view.tsconfigFor(importer.file)?.paths?.(specifier) ?? []) {
    const file = typeScriptFile(candidate, view);
    if (file !== undefined) return { file, suffix: '' };
  }
  return undefined;
}

/** Whether `context` is a `require()`, whose resolver takes paths where `import` takes `file:` URLs. */
function requires(context: Pick<ResolveHookContext, 'conditions'>): boolean {
  return context.conditions.includes('require');
}

/** `target` as a specifier the resolver behind `context` accepts. */
function targetSpecifier(target: Target, context: ResolveHookContext): string {
  return requires(context) ? target.file : `${pathToFileURL(target.file).href}${target.suffix}`;
}

/** The resolution, with a compiled file's format set to the one the loader compiles it for. */
function withFormat(resolution: Resolution): Resolution {
  const format = compiledSource(resolution.url)?.kind.format;
  return format === undefined || resolution.format === format ? resolution : { ...resolution, format };
}

/**
 * The resolution, joined to its importer's fresh graph: a project file
 * reached by path or by a `#` import from a module that carries
 * `GRAPH_PARAM` carries it too. A package reached by name keeps its shared
 * instance, even a workspace package that resolves outside `node_modules`: a
 * second instance of it would import a second instance of e2e itself.
 */
function inGraph(how: Reach, parentURL: string | undefined, resolution: Resolution): Resolution {
  if (how === 'package' || !resolution.url.startsWith('file:')) return resolution;
  const graph = graphOf(parentURL);
  const file = new URL(resolution.url);
  if (graph === null || !isProjectFile(file) || file.searchParams.has(GRAPH_PARAM)) return resolution;
  file.searchParams.set(GRAPH_PARAM, graph);
  return { ...resolution, url: file.href };
}

/**
 * Node.js's resolution of `request`, a `#` import or package export written
 * in a compiled file, retried on the TypeScript file behind the target it
 * did not find (`x.ts` for a mapped `./x.js`). An `import` only: Node.js
 * reports the missing target's URL on that error, and not on `require()`'s.
 */
function resolveExport(request: string, context: ResolveHookContext, nextResolve: NextResolve, view: ProjectView): Resolution {
  try {
    return nextResolve(request, context);
  } catch (error) {
    const { code, url } = error as { code?: unknown; url?: unknown };
    const missing = code === 'ERR_MODULE_NOT_FOUND' && typeof url === 'string' && url.startsWith('file:') ? fileURLToPath(url) : undefined;
    const file = missing === undefined ? undefined : swappedFile(missing, view);
    if (file === undefined || file === missing) throw error;
    return nextResolve(pathToFileURL(file).href, context);
  }
}

export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  const importer = compiledSource(context.parentURL);
  // Only an import written in a compiled file looks at the project's files.
  const view = importer === undefined ? undefined : projectView(graphOf(context.parentURL));
  const target = importer === undefined || view === undefined ? undefined : typeScriptTarget(specifier, importer, view);
  const how: Reach = target === undefined ? reach(specifier) : 'path';
  const request = target === undefined ? specifier : targetSpecifier(target, context);
  const resolution = withFormat(
    view !== undefined && how !== 'path' ? resolveExport(request, context, nextResolve, view) : nextResolve(request, context),
  );
  // CommonJS caches modules by file, with no query to make one fresh.
  return requires(context) ? resolution : inGraph(how, context.parentURL, resolution);
};

export const load: LoadHookSync = (url, context, nextLoad) => {
  const source = compiledSource(url);
  if (source !== undefined) {
    const { format } = source.kind;
    const loaded = nextLoad(url, { ...context, format });
    const compilerOptions = source.project ? (projectView(graphOf(url)).tsconfigFor(source.file)?.compilerOptions ?? {}) : {};
    return { format, source: compileTypeScript(source.file, text(loaded.source), source.kind, compilerOptions), shortCircuit: true };
  }
  // A require() has no import attributes, whatever the hook types say.
  if (url.startsWith('file:') && path.extname(new URL(url).pathname) === '.json' && !requires(context) && context.importAttributes?.type === undefined) {
    const loaded = nextLoad(url, { ...context, format: 'json', importAttributes: { ...context.importAttributes, type: 'json' } });
    return { format: 'module', source: `export default JSON.parse(${JSON.stringify(text(loaded.source))});\n`, shortCircuit: true };
  }
  return nextLoad(url, context);
};

/** Module source as text, a byte order mark dropped, whichever form the next hook returned it in. */
function text(source: ReturnType<LoadHookSync>['source']): string {
  if (source === undefined || source === null) return '';
  return typeof source === 'string' ? source.replace(/^﻿/, '') : new TextDecoder().decode(source);
}

/** Marks the process whose module loader already runs these hooks, whichever copy of e2e registered them. */
const registration = realmSlot<true>('e2e.typescript-loader.v1');

/**
 * Registers the hooks once per process, and has stack traces follow the
 * source maps the compiled files carry. Refuses a Node.js whose module hooks
 * the loader cannot rely on (`node-version.ts`).
 */
export function registerLoader(): void {
  if (registration.get(globalThis) === true) return;
  const unsupported = unsupportedNodeMessage(process.versions.node);
  if (unsupported !== undefined) throw new InfrastructureError('NODE_UNSUPPORTED', unsupported);
  nodeModule.registerHooks({ resolve, load });
  registration.set(globalThis, true);
  process.setSourceMapsEnabled(true);
}
