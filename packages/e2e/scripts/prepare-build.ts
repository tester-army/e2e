/**
 * Clears the previous build and copies in the files the package ships from
 * the repository root.
 *
 * `skills/e2e` ships as the package's agent skill, and the docs pages as
 * `docs/`, so coding agents read them offline from the installed package.
 * Only the `.mdx` pages ship: each carries its own copy of every
 * `docs/examples` file it shows (`check-docs-examples.ts`), and the site
 * assets mean nothing outside Mintlify. The root README ships as
 * the package README, so the npm page matches the repository page. npm
 * resolves no relative paths, so its `./` links become GitHub URLs: raw files
 * for images, the repository view for everything else.
 *
 * Usage: `node scripts/prepare-build.ts`, from the package directory.
 */

import { cpSync, globSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

for (const dir of ['dist', 'skills', 'docs']) rmSync(dir, { recursive: true, force: true });
cpSync('../../skills/e2e', 'skills/e2e', { recursive: true });
for (const page of globSync('**/*.mdx', { cwd: '../../docs', exclude: ['node_modules/**'] })) {
  cpSync(`../../docs/${page}`, `docs/${page}`);
}

const readme = readFileSync('../../README.md', 'utf8')
  .replaceAll('src="./', 'src="https://raw.githubusercontent.com/tester-army/e2e/main/')
  .replaceAll(/(href="|\]\()\.\//g, '$1https://github.com/tester-army/e2e/blob/main/');
writeFileSync('README.md', readme);
