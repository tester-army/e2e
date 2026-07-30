/** Maps a resolved target's driver setting to a driver instance. */

import type { Driver } from '../driver/index.ts';
import { WELL_KNOWN_DRIVERS, wellKnownDriverIds } from '../config/drivers.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import { ConfigurationError } from '../internal/errors.ts';

/**
 * Resolves the driver implementation for one target. Each call to a well-known
 * driver creates an independent instance (spec 09-drivers.md: one driver
 * instance per worker, sessions strictly serialized per instance).
 *
 * Well-known ids are loaded on demand from their own package, which keeps a
 * backend's dependencies out of installs that never use it. A missing package
 * is reported as a configuration error rather than a launch failure: it is
 * fixed by installing a dependency, so it must not enter the retry path.
 */
export async function resolveDriver(target: ResolvedTarget): Promise<Driver> {
  if (typeof target.driver !== 'string') return target.driver;
  const wellKnown = WELL_KNOWN_DRIVERS[target.driver];
  if (wellKnown === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${target.name}" driver must be ${wellKnownDriverIds()} or a defineDriver handle`,
    );
  }
  let factory: unknown;
  try {
    // The specifier is a variable so the optional peer stays out of this
    // package's module graph at build time as well as at install time.
    factory = ((await import(wellKnown.specifier)) as Record<string, unknown>)[target.driver];
  } catch (cause) {
    throw new ConfigurationError(
      'DRIVER_NOT_INSTALLED',
      `target "${target.name}" uses the "${target.driver}" driver, which ships separately in "${wellKnown.specifier}"; install it to run this target`,
      { cause },
    );
  }
  if (typeof factory !== 'function') {
    throw new ConfigurationError(
      'DRIVER_NOT_INSTALLED',
      `"${wellKnown.specifier}" does not export a "${target.driver}" driver factory`,
    );
  }
  return (factory as () => Driver)();
}
