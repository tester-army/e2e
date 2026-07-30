/**
 * Manifest coupling guard (spec/15-conformance-matrix.md:35-37).
 *
 * A normative change to the conformance manifest or to any wire schema must
 * bump `suiteVersion` in the same review: implementations key their conformance
 * reports to that version, so a silent edit makes every existing report claim
 * conformance to requirements it was never run against.
 *
 * Usage: node scripts/check-manifest-coupling.mjs [baseRef]
 * Base ref precedence: argv[1] -> GITHUB_BASE_REF -> origin/main.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MANIFEST = 'spec/conformance/v0-requirements.json';
const SCHEMA_PREFIX = 'spec/schema/';

/**
 * Runs a git command and returns its trimmed stdout.
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Reads `suiteVersion` out of a manifest document.
 * @param {string} source Manifest JSON text.
 * @param {string} origin Human-readable location, used in errors.
 * @returns {string}
 */
function suiteVersion(source, origin) {
  const parsed = JSON.parse(source);
  const version = parsed?.suiteVersion;
  if (typeof version !== 'string') {
    throw new Error(`${origin}: expected a string "suiteVersion"`);
  }
  return version;
}

/**
 * Resolves the merge base between the base ref and the working tree.
 * @param {string} baseRef
 * @returns {string} Commit sha.
 */
function mergeBase(baseRef) {
  const candidates = baseRef.startsWith('origin/') ? [baseRef] : [`origin/${baseRef}`, baseRef];
  for (const candidate of candidates) {
    try {
      return git(['merge-base', candidate, 'HEAD']);
    } catch {
      continue;
    }
  }
  throw new Error(
    `cannot resolve a merge base for "${baseRef}". Fetch it first ` +
      '(actions/checkout needs fetch-depth: 0).',
  );
}

const baseRef = process.argv[2] ?? process.env.GITHUB_BASE_REF ?? 'origin/main';
const base = mergeBase(baseRef);

// Compares the merge base to the working tree, so this reports the same answer
// on a clean CI checkout and on a dirty local branch.
const changed = git(['diff', '--name-only', base]).split('\n').filter(Boolean);
const coupled = changed.filter((file) => file === MANIFEST || file.startsWith(SCHEMA_PREFIX));

if (coupled.length === 0) {
  console.log(`No conformance manifest or schema changes since ${baseRef}.`);
  process.exit(0);
}

const before = suiteVersion(git(['show', `${base}:${MANIFEST}`]), `${base}:${MANIFEST}`);
const after = suiteVersion(readFileSync(MANIFEST, 'utf8'), MANIFEST);

if (before === after) {
  const list = coupled.map((file) => `  - ${file}`).join('\n');
  console.error(
    `Normative change without a suite-version bump (suiteVersion stayed ${before}):\n${list}\n\n` +
      `Bump "suiteVersion" in ${MANIFEST} and update the affected declarations, ` +
      'prose, examples, and conformance reports in this same change ' +
      '(spec/15-conformance-matrix.md).',
  );
  process.exit(1);
}

console.log(`suiteVersion ${before} -> ${after} for ${coupled.length} coupled change(s).`);
