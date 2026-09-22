/**
 * Fails when a public package's `e2e` peer is anything but
 * `>=<major.minor.patch> <major+1>`.
 *
 * `changeset version --snapshot canary` rewrites that peer to the runner's
 * exact canary version, and the canary output is committed to main as
 * `chore: release`. An exact pin that lands makes changesets patch-bump every
 * engine and rewrite the pin on each runner release, and leaves a consumer who
 * updates `e2e` alone with a peer npm 7+ refuses (ERESOLVE).
 * `restore-peer-ranges.ts` puts the range back after a publish; this check is
 * what notices when it did not run.
 *
 * Usage: `node scripts/check-peer-ranges.ts`, part of `pnpm check`. Exits 1
 * listing every offending package.
 */

import { relative } from 'node:path';
import { REPO_ROOT, RUNNER, isRunnerPeerRange, publicPackages } from './public-packages.ts';

const problems: string[] = [];
const checked: string[] = [];
for (const { path, manifest } of publicPackages()) {
  const range = manifest.peerDependencies?.[RUNNER];
  if (range === undefined) continue;
  checked.push(`${manifest.name} (${range})`);
  if (!isRunnerPeerRange(range)) {
    problems.push(
      `${relative(REPO_ROOT, path)}: ${RUNNER} peer is ${JSON.stringify(range)}, expected >=<major.minor.patch> <major+1>; run \`node scripts/restore-peer-ranges.ts\``,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`peer ranges: ${checked.toSorted().join(', ')} peer on ${RUNNER} as a wide range\n`);
}
