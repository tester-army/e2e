/**
 * Driver ids this runner resolves by name (spec 09-drivers.md).
 *
 * Each entry maps to a package declared as an optional peer dependency, so a
 * project driving another backend never pays for a browser download. The
 * declared capabilities are a static hint: selection runs before any driver is
 * instantiated and needs to know which fixtures a target can serve. The real
 * manifest is still validated against the instance before the first launch, so
 * a hint that drifts fails the run rather than silently mis-selecting.
 */

import type { Capability } from '../types.ts';

export interface WellKnownDriver {
  /** Package that exports the driver factory under the driver id. */
  readonly specifier: string;
  /** Fixture capabilities the package declares in its manifest. */
  readonly capabilities: readonly Capability[];
}

export const WELL_KNOWN_DRIVERS: Readonly<Record<string, WellKnownDriver>> = {
  playwright: { specifier: '@e2edev/playwright', capabilities: ['web'] },
};

export type WellKnownDriverId = keyof typeof WELL_KNOWN_DRIVERS;

/** Driver a web target uses when config names none. */
export const DEFAULT_DRIVER_ID: WellKnownDriverId = 'playwright';

/** Returns true when the value names a driver this runner can resolve. */
export function isWellKnownDriverId(value: unknown): value is WellKnownDriverId {
  return typeof value === 'string' && Object.hasOwn(WELL_KNOWN_DRIVERS, value);
}

/** Human-readable list of resolvable driver ids, for configuration errors. */
export function wellKnownDriverIds(): string {
  return Object.keys(WELL_KNOWN_DRIVERS)
    .map((id) => `"${id}"`)
    .join(', ');
}
