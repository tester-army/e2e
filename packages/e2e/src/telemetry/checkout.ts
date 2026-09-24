/**
 * Whether the CLI runs from a source checkout of the repository rather than
 * from an installed package. Work on e2e itself is not usage, so a checkout
 * sends no telemetry.
 */

import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl`, the CLI's own module, sits outside every
 * `node_modules` directory. Each install puts the package under one: a
 * project's `node_modules/e2e`, pnpm's `node_modules/.pnpm/...`, a global
 * npm or npx cache, Yarn's zip cache. The checkout's `packages/e2e/dist`
 * has none on its path. A URL that is not a file counts as installed.
 */
export function runsFromCheckout(moduleUrl: string): boolean {
  try {
    return !fileURLToPath(moduleUrl).split(/[\\/]/u).includes('node_modules');
  } catch {
    return false;
  }
}
