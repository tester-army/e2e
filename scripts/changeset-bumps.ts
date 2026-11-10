/**
 * The bump policy for pending changesets while a package is `0.x`.
 *
 * Changesets applies whatever bump a changeset declares, and one `minor` in a
 * release moves the package from `0.20.x` to `0.21.0`. On `0.x` that is the
 * breaking slot: semver tools read `^0.20.0` as `>=0.20.0 <0.21.0`, so a
 * project `e2e init` set up never picks up a minor without editing its
 * `package.json`. A feature or fix is a `patch`. A `minor` is for a breaking
 * change or a release a maintainer calls, its summary opening with
 * `**Breaking:**` or `**Release:**`. A `major` makes it `1.0.0`, outside every
 * sibling's `>=x <1` peer range, so only a `**Release:**` may carry one.
 *
 * Rule (a) of #1657 sits here too: a changeset that raises a package's peer
 * floor on a sibling past a runner minor the previous range accepted must
 * be a `**Breaking:**` minor. The check script pairs each pending changeset
 * with the floor change it ships: the previous floor is the one at the
 * package's release tag, the current floor is the working tree's, and a
 * raise counts only when it cuts off a *released* version on an older
 * minor. A correction from a never-published floor to the version it
 * already meant in practice (for example `>=0.22.1` to `>=0.23.0`, where
 * the previous range accepted only released `0.23.0`) cuts off nothing a
 * consumer could install, so a patch carries it. The rule lives in this
 * check, not in `check-peer-ranges.ts`, because only this check reads the
 * changesets that must announce the raise.
 */

import { parseChangesetFile } from '@changesets/parse';

export type Changeset = ReturnType<typeof parseChangesetFile>;

export const BREAKING = '**Breaking:**';
export const RELEASE = '**Release:**';

/** The `minor` and `major` bumps in `changeset` of a `0.x` package in `versions` that its summary does not allow. */
export function disallowedBumps(changeset: Changeset, versions: ReadonlyMap<string, string>): { name: string; type: 'minor' | 'major' }[] {
  const allowed = changeset.summary.startsWith(RELEASE) ? ['minor', 'major'] : changeset.summary.startsWith(BREAKING) ? ['minor'] : [];
  return changeset.releases.flatMap(({ name, type }) =>
    (type === 'minor' || type === 'major') && !allowed.includes(type) && versions.get(name)?.startsWith('0.') === true ? [{ name, type }] : [],
  );
}

export type BumpType = 'patch' | 'minor' | 'major';
export type Semver = readonly [major: number, minor: number, patch: number];

/** Parses a strict `x.y.z` version; undefined for anything else. */
export function parseVersion(version: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [Number(major), Number(minor), Number(patch)];
}

/** -1, 0, or 1, semver order on `x.y.z` triples. */
function compareVersions(a: Semver, b: Semver): number {
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/**
 * Whether raising a peer floor from `previousFloor` to `currentFloor`
 * cuts off a released version on an older runner minor: some version in
 * `released` that the previous range accepted (`>=previousFloor` in its
 * major) sits below the new floor on an older minor. A raise within one
 * minor, a lowering, and a correction from a never-published floor to the
 * version it already meant in practice all answer false.
 */
export function floorRaisesPastMinor(previousFloor: string, currentFloor: string, released: ReadonlySet<string>): boolean {
  const previous = parseVersion(previousFloor);
  const current = parseVersion(currentFloor);
  if (previous === undefined || current === undefined) return false;
  if (compareVersions(current, previous) <= 0) return false;
  for (const version of released) {
    const candidate = parseVersion(version);
    if (candidate === undefined || candidate[0] !== previous[0]) continue;
    if (compareVersions(candidate, previous) < 0 || compareVersions(candidate, current) >= 0) continue;
    if (candidate[0] !== current[0] || candidate[1] < current[1]) return true;
  }
  return false;
}

/** Whether a changeset entry of `type` with `summary` announces a floor raise: a minor opening `**Breaking:**` or `**Release:**`, or a major opening `**Release:**`. */
export function announcesFloorRaise(type: BumpType, summary: string): boolean {
  if (type === 'minor') return summary.startsWith(BREAKING) || summary.startsWith(RELEASE);
  if (type === 'major') return summary.startsWith(RELEASE);
  return false;
}

const BUMP_RANK: Record<BumpType, number> = { patch: 0, minor: 1, major: 2 };

/** The highest bump each package gets across `changesets`; a release type that bumps nothing is skipped. */
export function pendingBumps(changesets: readonly Changeset[]): Map<string, BumpType> {
  const bumps = new Map<string, BumpType>();
  for (const changeset of changesets) {
    for (const { name, type } of changeset.releases) {
      if (!(type in BUMP_RANK)) continue;
      const bump = type as BumpType;
      const current = bumps.get(name);
      if (current === undefined || BUMP_RANK[bump] > BUMP_RANK[current]) bumps.set(name, bump);
    }
  }
  return bumps;
}

/** The version a `type` bump of `version` releases; undefined when `version` is not `x.y.z`. */
export function nextVersionAfterBump(version: string, type: BumpType): string | undefined {
  const parsed = parseVersion(version);
  if (parsed === undefined) return undefined;
  const [major, minor, patch] = parsed;
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

export interface FloorRaiseInput {
  readonly name: string;
  readonly path: string;
  readonly peer: string;
  readonly previousFloor: string;
  readonly currentFloor: string;
  readonly released: ReadonlySet<string>;
  readonly changes: readonly { type: BumpType; summary: string }[];
  readonly alreadyFlagged: boolean;
}

/**
 * Every floor raise in `inputs` that no pending changeset announces as a
 * `**Breaking:**` minor. A package whose bump `disallowedBumps` already
 * flags is skipped: the same summary fix (opening it with `**Breaking:**`)
 * cures both, so it is reported once, there.
 */
export function floorRaiseProblems(inputs: readonly FloorRaiseInput[]): string[] {
  const problems: string[] = [];
  for (const input of inputs) {
    if (!floorRaisesPastMinor(input.previousFloor, input.currentFloor, input.released)) continue;
    if (input.changes.some((change) => announcesFloorRaise(change.type, change.summary))) continue;
    if (input.alreadyFlagged) continue;
    const highest = input.changes.reduce<BumpType | undefined>(
      (top, change) => (top === undefined || BUMP_RANK[change.type] > BUMP_RANK[top] ? change.type : top),
      undefined,
    );
    const fix =
      highest === undefined
        ? `with no changeset for ${input.name}; add a minor changeset whose summary opens ${BREAKING}`
        : `with only a ${highest} bump; make it a minor whose summary opens ${BREAKING}`;
    problems.push(
      `${input.path}: ${input.peer} peer floor rises ${input.previousFloor} -> ${input.currentFloor}, past a runner minor the previous range accepted, ${fix}`,
    );
  }
  return problems;
}
