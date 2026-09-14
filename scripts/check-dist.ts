/**
 * Refuses to publish a `dist` that was not built for the version being
 * published.
 *
 * Three canaries on 2026-09-14 shipped a dist compiled days earlier: the
 * version step ran, the build step did not, and `changeset publish` packed
 * whatever `dist` held. Each package runs this as `prepublishOnly`, so
 * `pnpm publish` (and therefore `changeset publish`) stops when the stamp
 * `stamp-dist.ts` wrote at build time does not name the version in
 * package.json.
 *
 * A bare `changeset publish` goes through `pnpm publish` in each package
 * directory, so the hook runs there too; only the root `canary` and
 * `release` scripts build before publishing.
 *
 * Usage: `node ../../scripts/check-dist.ts`, from the package directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };
const stampPath = resolve('dist', '.build.json');

if (!existsSync(stampPath)) {
  console.error(`${name}@${version}: dist has no build stamp (${stampPath}); use \`pnpm run canary\` or \`pnpm run release\`, which build first`);
  process.exit(1);
}

const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as { version?: string };
if (stamp.version !== version) {
  console.error(
    `${name}@${version}: dist was built for ${stamp.version ?? 'an unknown version'}; use \`pnpm run canary\` or \`pnpm run release\`, which build first`,
  );
  process.exit(1);
}
