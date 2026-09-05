/** Package-scope diagnostics for TypeScript config and test entry points. */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Explains how to opt a `.ts` entry point's package into ESM when required. */
export function esmPackageHint(modulePath: string): string | undefined {
  const filename = existsSync(modulePath) ? realpathSync(modulePath) : modulePath;
  if (path.extname(filename) !== '.ts') return undefined;

  let dir = path.dirname(filename);
  for (;;) {
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        // Leave malformed or unreadable manifests to the loader's own diagnostic.
        return undefined;
      }
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        return undefined;
      }
      if ('type' in manifest && manifest.type === 'module') return undefined;
      return `e2e requires ES modules for .ts config and test files, but ${manifestPath} does not set "type": "module". To opt this package into ESM, run npm pkg set type=module from ${dir}. This also changes how existing .js files in the package are interpreted.`;
    }
    const parent = path.dirname(dir);
    if (parent === dir || path.basename(parent) === 'node_modules') break;
    dir = parent;
  }

  return `e2e requires ES modules for .ts config and test files. Create a package.json with "type": "module" in ${path.dirname(filename)}, or run e2e init in the project directory.`;
}
