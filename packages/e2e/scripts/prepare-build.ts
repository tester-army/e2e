/**
 * Clears the previous build and copies in the files the package ships from
 * the repository root.
 *
 * `skills/e2e` ships as the package's agent skill. The root README ships as
 * the package README, so the npm page matches the repository page. npm
 * resolves no relative paths, so its `./` links become GitHub URLs: raw files
 * for images, the repository view for everything else.
 *
 * Usage: `node scripts/prepare-build.ts`, from the package directory.
 */

import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

for (const dir of ['dist', 'skills']) rmSync(dir, { recursive: true, force: true });
cpSync('../../skills/e2e', 'skills/e2e', { recursive: true });

const readme = readFileSync('../../README.md', 'utf8')
  .replaceAll('src="./', 'src="https://raw.githubusercontent.com/tester-army/e2e/main/')
  .replaceAll(/(href="|\]\()\.\//g, '$1https://github.com/tester-army/e2e/blob/main/');
writeFileSync('README.md', readme);
