/**
 * Module customization hook: the TypeScript a project reaches by path is ESM,
 * whatever the nearest package.json says.
 *
 * Config and tests load through tsx's ESM API. tsx types a `.ts` file by its
 * package scope and hands a CommonJS-scoped one to Node's require, which that
 * API never hooks, so the import fails as "cannot find module" on a path that
 * carries e2e's cache-busting query. Registered before tsx, this hook runs
 * inside tsx's chain: tsx's resolve receives `format: 'module'` from it and
 * transforms the file as ESM. A Next.js app, or any package without
 * `"type": "module"`, keeps its module type.
 *
 * Only path specifiers are forced: the entry file URL, `./helper.ts`, and
 * tsconfig `paths` aliases, which tsx maps to `file:` URLs (on every platform)
 * before calling this hook.
 * A bare specifier is a package, linked or installed, and keeps the format its
 * own manifest declares; `.cts` files stay CommonJS.
 */

import type { ResolveHook, ResolveHookSync } from 'node:module';

type Resolution = ReturnType<ResolveHookSync>;

const TYPESCRIPT_MODULE = /\.(?:ts|mts|tsx)$/;
const PATH_SPECIFIER = /^(?:\.{1,2}\/|\/|file:)/;

/** The resolution, with a TypeScript file reached by path marked as an ES module. */
export function asModule(specifier: string, resolution: Resolution): Resolution {
  if (resolution.format === 'module' || resolution.format === 'module-typescript') return resolution;
  if (!PATH_SPECIFIER.test(specifier) || !resolution.url.startsWith('file:')) return resolution;
  if (!TYPESCRIPT_MODULE.test(new URL(resolution.url).pathname)) return resolution;
  return { ...resolution, format: 'module' };
}

/** For `module.registerHooks`. */
export const resolveSync: ResolveHookSync = (specifier, context, nextResolve) =>
  asModule(specifier, nextResolve(specifier, context));

/** For `module.register`, which reads this export from the hook module. */
export const resolve: ResolveHook = async (specifier, context, nextResolve) =>
  asModule(specifier, await nextResolve(specifier, context));
