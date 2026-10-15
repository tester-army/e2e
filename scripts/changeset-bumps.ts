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
