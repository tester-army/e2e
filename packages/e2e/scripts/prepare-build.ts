/**
 * Clears the previous build and copies in the files the package ships from
 * the repository root.
 *
 * `skills/e2e` ships as the package's agent skill. The root README ships as
 * the package README, so the npm page matches the repository page.
 *
 * Usage: `node scripts/prepare-build.ts`, from the package directory.
 */

import { copyFileSync, cpSync, rmSync } from 'node:fs';

for (const dir of ['dist', 'skills']) rmSync(dir, { recursive: true, force: true });
cpSync('../../skills/e2e', 'skills/e2e', { recursive: true });
copyFileSync('../../README.md', 'README.md');
