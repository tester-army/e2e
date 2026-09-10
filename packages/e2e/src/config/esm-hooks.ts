/**
 * Module customization hook: TypeScript outside node_modules is an ES module,
 * whatever the nearest package.json says.
 *
 * Config and tests load through tsx's ESM API. tsx types a `.ts` file by its
 * package scope and hands a CommonJS-scoped one to Node's require, which that
 * API never hooks, so the import fails as "cannot find module" on a path that
 * carries e2e's cache-busting query. Registered before tsx, this hook runs
 * inside tsx's chain: tsx's resolve receives `format: 'module'` from it and
 * transforms the file as ESM. A Next.js app, or any package without
 * `"type": "module"`, keeps its manifest; `.cts` files and dependencies keep
 * their own format.
 */

import type { ResolveHook, ResolveHookSync } from 'node:module';

type Resolution = ReturnType<ResolveHookSync>;

const TYPESCRIPT_MODULE = /\.(?:ts|mts|tsx)$/;

/** The resolution, with a project TypeScript file marked as an ES module. */
export function asModule(resolution: Resolution): Resolution {
  if (resolution.format === 'module' || resolution.format === 'module-typescript') return resolution;
  if (!resolution.url.startsWith('file:')) return resolution;
  const { pathname } = new URL(resolution.url);
  if (!TYPESCRIPT_MODULE.test(pathname) || pathname.split('/').includes('node_modules')) return resolution;
  return { ...resolution, format: 'module' };
}

/** For `module.registerHooks`. */
export const resolveSync: ResolveHookSync = (specifier, context, nextResolve) =>
  asModule(nextResolve(specifier, context));

/** For `module.register`, which reads this export from the hook module. */
export const resolve: ResolveHook = async (specifier, context, nextResolve) =>
  asModule(await nextResolve(specifier, context));
