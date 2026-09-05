/**
 * Pre-1.0 release policy: every release is a patch.
 *
 * The packages ship several times a week, and each `minor` changeset would move
 * the version a whole 0.x step, so features and fixes alike declare `patch`
 * until 1.0. This guard fails any pending changeset that declares `minor` or
 * `major` for a package still below 1.0.0. Raise a package to 1.0.0 to lift the
 * rule for it.
 *
 * Usage: node scripts/check-changesets.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const changesetDir = path.join(root, '.changeset');

/** @returns {Map<string, string>} package name -> version */
function packageVersions() {
  const versions = new Map();
  const packagesDir = path.join(root, 'packages');
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(readFileSync(path.join(packagesDir, entry.name, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        versions.set(manifest.name, manifest.version);
      }
    } catch {
      // not a package
    }
  }
  return versions;
}

/** @param {string} source @returns {Array<{ name: string, bump: string }>} */
function frontmatterBumps(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (match === null) return [];
  const bumps = [];
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^\s*["']?([^"':]+)["']?\s*:\s*["']?(\w+)["']?\s*$/.exec(line);
    if (pair !== null) bumps.push({ name: pair[1].trim(), bump: pair[2] });
  }
  return bumps;
}

const versions = packageVersions();
const violations = [];
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith('.md') || file === 'README.md') continue;
  for (const { name, bump } of frontmatterBumps(readFileSync(path.join(changesetDir, file), 'utf8'))) {
    const version = versions.get(name);
    if (version === undefined) continue;
    const major = Number(version.split('.')[0]);
    if (major < 1 && bump !== 'patch') {
      violations.push(`.changeset/${file}: ${name} is ${version} and declares "${bump}"; use "patch" until 1.0`);
    }
  }
}

if (violations.length > 0) {
  console.error('Pre-1.0 releases are patches only (CONTRIBUTING.md, Changesets):');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('Pending changesets follow the pre-1.0 patch policy.');
