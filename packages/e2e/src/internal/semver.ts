/**
 * The slice of semantic versioning the CLI needs to reason about releases:
 * parsing, ordering, and the peer ranges the published packages carry
 * (`>=0.15.0 <1`, or one exact build for a prerelease). Anything else, a
 * caret or a tilde included, is a range this module does not read.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const PARTIAL = /^v?(\d+)(?:\.(\d+)(?:\.(\d+)(?:-([0-9A-Za-z.-]+))?)?)?$/u;
const COMPARATOR = /^(>=|<=|>|<|=)?(.+)$/u;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The dot-separated prerelease identifiers; empty for a release. */
  readonly prerelease: readonly string[];
}

/** A full `major.minor.patch[-pre][+build]` version, a leading `v` allowed, or undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split('.') ?? [] };
}

/** The version as npm writes it, without a build suffix. */
export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join('.')}`;
}

/** Negative when `a` comes before `b`, positive after, 0 when they are the same release. */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/** Numeric identifiers sort numerically and before alphanumeric ones, which sort by code point. */
function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/u;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Comparator {
  readonly operator: '>=' | '<=' | '>' | '<' | '=';
  readonly version: Version;
}

/**
 * Whether `version` satisfies `range`: comparator sets joined by `||`, each a
 * space-separated list of `>=`, `>`, `<=`, `<`, `=`, or bare versions, where
 * a partial version fills the missing parts with zero (`<1` is `<1.0.0`). As
 * in node-semver, a prerelease satisfies a set only when one of its
 * comparators names a prerelease of the same `major.minor.patch`. A range
 * outside this grammar is satisfied by nothing.
 */
export function satisfies(version: Version, range: string): boolean {
  const sets = range.split('||').map(parseComparatorSet);
  return sets.some((set) => set !== undefined && setSatisfies(version, set));
}

function parseComparatorSet(text: string): Comparator[] | undefined {
  const parts = text.trim().split(/\s+/u).filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  const comparators: Comparator[] = [];
  for (const part of parts) {
    const match = COMPARATOR.exec(part);
    const partial = match === null ? null : PARTIAL.exec(match[2]!);
    if (match === null || partial === null) return undefined;
    // A bare `1.2` would mean `1.2.x`; only full versions stand for themselves.
    if ((match[1] === undefined || match[1] === '=') && partial[3] === undefined) return undefined;
    comparators.push({
      operator: (match[1] ?? '=') as Comparator['operator'],
      version: {
        major: Number(partial[1]),
        minor: Number(partial[2] ?? 0),
        patch: Number(partial[3] ?? 0),
        prerelease: partial[4]?.split('.') ?? [],
      },
    });
  }
  return comparators;
}

function setSatisfies(version: Version, set: readonly Comparator[]): boolean {
  const holds = set.every(({ operator, version: bound }) => {
    const order = compareVersions(version, bound);
    switch (operator) {
      case '>=':
        return order >= 0;
      case '>':
        return order > 0;
      case '<=':
        return order <= 0;
      case '<':
        return order < 0;
      case '=':
        return order === 0;
    }
  });
  if (!holds || version.prerelease.length === 0) return holds;
  return set.some(
    ({ version: bound }) =>
      bound.prerelease.length > 0 && bound.major === version.major && bound.minor === version.minor && bound.patch === version.patch,
  );
}
