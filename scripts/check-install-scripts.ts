/**
 * Fails when installing a published package would run a dependency's
 * install script (`install-scripts.ts` says why that breaks pnpm 11 and
 * later for every new user).
 *
 * Usage: `node scripts/check-install-scripts.ts` after `pnpm install`, part
 * of `pnpm check`. Exits 1 listing every package that would run one and the
 * dependency chain that brings it in.
 */

import { dirname } from 'node:path';
import { findInstallScripts } from './install-scripts.ts';
import { publicPackages } from './public-packages.ts';

const problems: string[] = [];
const checked: string[] = [];
for (const { path, manifest } of publicPackages()) {
  checked.push(manifest.name);
  for (const { chain, runs } of findInstallScripts(dirname(path))) {
    problems.push(`${chain} runs an install script (${runs}); every pnpm 11+ install of ${manifest.name} fails on it`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`install scripts: none in the dependency trees of ${checked.toSorted().join(', ')}\n`);
}
