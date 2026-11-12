/**
 * The `[version]` argument of `e2e upgrade`. Apart from the upgrade itself so
 * the CLI parses the argument without loading the upgrade.
 */

import { InvalidArgumentError } from 'commander';
import { formatVersion, parseVersion } from '../internal/semver.ts';

/** What to upgrade to: a dist-tag such as `latest` or `nightly`, or one published version. */
export type UpgradeTarget = { readonly kind: 'tag'; readonly tag: string } | { readonly kind: 'version'; readonly version: string };

const DIST_TAG = /^[a-z][a-z0-9._-]*$/iu;

/**
 * The `[version]` argument: an exact version (`0.22.0`, `v0.22.0`,
 * `0.22.1-nightly-20261019081103`) or a dist-tag (`latest`, `nightly`).
 * Ranges are refused: the command installs one version.
 */
export function parseUpgradeTarget(value: string): UpgradeTarget {
  const version = parseVersion(value);
  if (version !== undefined) return { kind: 'version', version: formatVersion(version) };
  if (DIST_TAG.test(value) && !/^v?\d/u.test(value)) return { kind: 'tag', tag: value };
  throw new InvalidArgumentError('must be a version such as 0.22.0 or a dist-tag such as latest or nightly, not a range');
}
