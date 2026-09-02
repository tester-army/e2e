/**
 * Private-phase publisher: publishes both packages to npmjs as RESTRICTED,
 * renaming the core package to `@e2edev/e2e` in the published tarball only.
 *
 * The repo keeps the name `e2e` everywhere — the spec, the docs, the fixture
 * suites, and the package self-reference all depend on it, and the unscoped
 * name is the public launch. Only the manifest that leaves the building is
 * rewritten; the file is restored byte-for-byte afterwards.
 *
 * A consumer installs the pair as:
 *
 *   "e2e": "npm:@e2edev/e2e@^x.y.z",
 *   "@e2edev/playwright": "^x.y.z"
 *
 * The alias key `e2e` satisfies the driver's peer range and resolves the
 * driver's own `e2e/...` imports; without the alias, pnpm's peer
 * auto-install would fetch the unrelated unscoped `e2e` package — every
 * private consumer MUST declare the alias.
 *
 * Safety: `publishConfig.access` is `restricted` in-repo, which makes any
 * accidental direct `npm publish` of the unscoped name fail (unscoped
 * packages cannot be restricted). Public launch day reverts to
 * `release:public`, which is the plain changesets publish.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PRIVATE_CORE_NAME = '@e2edev/e2e';

publishPackage('packages/e2e', (pkg) => ({ ...pkg, name: PRIVATE_CORE_NAME }));
publishPackage('packages/playwright', (pkg) => pkg);

/** Publishes one package with a rewritten manifest, restoring it afterwards. */
function publishPackage(dir, rewrite) {
  const manifestPath = path.join(dir, 'package.json');
  const original = readFileSync(manifestPath, 'utf8');
  const pkg = rewrite(JSON.parse(original));
  pkg.publishConfig = {
    ...pkg.publishConfig,
    access: 'restricted',
    provenance: false,
    tag: 'beta',
  };

  if (alreadyPublished(pkg.name, pkg.version)) {
    console.log(`skip ${pkg.name}@${pkg.version} (already published)`);
    return;
  }

  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    execSync('npm publish --tag beta', { cwd: dir, stdio: 'inherit' });
    console.log(`published ${pkg.name}@${pkg.version} (restricted, beta)`);
  } finally {
    writeFileSync(manifestPath, original);
  }
}

/** True when this exact version is already on the registry. */
function alreadyPublished(name, version) {
  try {
    const found = execSync(`npm view ${name}@${version} version`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return found === version;
  } catch {
    return false;
  }
}
