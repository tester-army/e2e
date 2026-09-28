/**
 * Module customization hook: the TypeScript a project owns is ESM, whatever
 * the nearest package.json says.
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
 */

import type { ResolveHook, ResolveHookContext, ResolveHookSync } from 'node:module';

type Resolution = ReturnType<ResolveHookSync>;

const TYPESCRIPT_MODULE = /\.(?:ts|mts|tsx)$/;
const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/;
/** A file inside an installed package. */
const INSTALLED = /\/node_modules\//;
/** The tsx namespace e2e registers; tsx tags every URL it loads with it. */
export const TSX_NAMESPACE = 'e2e';

/** Whether tsx loaded the importing module under e2e's namespace, so it will load this one too. */
function inTsxNamespace(parentURL: string | undefined): boolean {
  return parentURL?.startsWith('file:') === true && new URL(parentURL).searchParams.get('tsx-namespace') === TSX_NAMESPACE;
}

/** The resolution, with TypeScript reached by path, or by name from outside `node_modules` under tsx, marked as an ES module. */
export function asModule(specifier: string, context: Pick<ResolveHookContext, 'parentURL'>, resolution: Resolution): Resolution {
  if (resolution.format === 'module' || resolution.format === 'module-typescript') return resolution;
  if (!resolution.url.startsWith('file:')) return resolution;
  const { pathname } = new URL(resolution.url);
  if (!TYPESCRIPT_MODULE.test(pathname)) return resolution;
  if (!PATH_SPECIFIER.test(specifier) && (INSTALLED.test(pathname) || !inTsxNamespace(context.parentURL))) {
    return resolution;
  }
  return { ...resolution, format: 'module' };
}

/** For `module.registerHooks`. */
export const resolveSync: ResolveHookSync = (specifier, context, nextResolve) =>
  asModule(specifier, context, nextResolve(specifier, context));

/** For `module.register`, which reads this export from the hook module. */
export const resolve: ResolveHook = async (specifier, context, nextResolve) =>
  asModule(specifier, context, await nextResolve(specifier, context));
