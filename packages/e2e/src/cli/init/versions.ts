/**
 * Versions of the sibling packages released with this runner, recorded by the
 * build in `sibling-versions.json` next to this module from their manifests.
 * Absent when running from source. Both preset tables read from here.
 */

import { readJson } from '../../internal/package-version.ts';

const SIBLING_VERSIONS = readJson(import.meta.url, './sibling-versions.json') as Readonly<Record<string, string>> | undefined;

/**
 * The range init writes for the runner and for an engine. Engines version
 * independently of the runner and pin it through their own peer range, so init
 * asks for the minor of the engine released alongside this runner. Package managers resolve a
 * range to the registry's `latest` tag whenever it satisfies, and `latest`
 * can trail the tag the runner came from by several minors, so a bare `0.x`
 * installed engines whose peer range rejected the runner.
 *
 * A canary runner pins itself and the exact engine build it shipped with.
 * Every canary engine names one runner build in its peer range, and a caret on
 * a prerelease resolves to the newest prerelease of that tuple, which names a
 * different one.
 */
export function dependencyRange(version: string | undefined): string {
  if (version === undefined) return '0.x';
  return version.includes('-') ? version : `^${version}`;
}

/** The range init writes for a sibling `@e2e-dev/*` package released alongside this runner. */
export function siblingDependency(name: string): Readonly<Record<string, string>> {
  return { [name]: dependencyRange(SIBLING_VERSIONS?.[name]) };
}

