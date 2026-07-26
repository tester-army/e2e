/** Maps a resolved target's driver setting to a driver instance. */

import type { Driver } from '../driver/index.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import { playwright } from '../playwright/index.ts';

/**
 * Resolves the driver implementation for one target. Each call to the bundled
 * `playwright` driver creates an independent instance (spec 09-drivers.md:
 * one driver instance per worker, sessions strictly serialized per instance).
 */
export function resolveDriver(target: ResolvedTarget): Driver {
  if (target.driver === 'playwright') return playwright();
  return target.driver;
}
