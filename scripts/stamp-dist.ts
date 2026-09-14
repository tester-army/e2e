/**
 * Records which package version a `dist` was compiled for.
 *
 * Every publishable package runs this as the last step of its build. The
 * stamp is what `check-dist.ts` compares against before a publish, so a
 * package.json that `changeset version` bumped after the last build cannot
 * ship the previous build's output.
 *
 * Usage: `node ../../scripts/stamp-dist.ts`, from the package directory.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
writeFileSync('dist/.build.json', `${JSON.stringify({ version })}\n`);
