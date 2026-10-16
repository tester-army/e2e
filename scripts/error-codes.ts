/**
 * The `src` directory of every published package, the roots
 * `check-error-codes.ts` scans for the codes the reference must document.
 *
 * Derived from the manifests rather than hand-kept: a new engine or
 * integration must not have to remember to add itself here to have its codes
 * checked, which is how `packages/eas/src` and `packages/smol/src` were
 * missing while this was a literal list. A package with no `src` yet is
 * skipped.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { REPO_ROOT, publicPackages } from './public-packages.ts';

/** Every published package's `src`, project-relative with `/` separators. */
export function sourceRoots(): string[] {
  return publicPackages()
    .map(({ path }) => `${relative(REPO_ROOT, dirname(path)).split('\\').join('/')}/src`)
    .filter((dir) => existsSync(join(REPO_ROOT, dir)))
    .toSorted();
}
