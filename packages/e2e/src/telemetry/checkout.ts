/**
 * Whether the CLI runs from a source checkout of the repository rather than
 * from an installed package. Work on e2e itself is not usage, so a checkout
 * sends no telemetry.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the source of the CLI sits next to `moduleUrl`, the CLI's own
 * module: `src/cli/index.ts` two directories up, where the checkout keeps it
 * beside `dist`. No install ships `src`, wherever the package is unpacked,
 * so the marker is positive. A URL that is not a file counts as installed.
 */
export function runsFromCheckout(moduleUrl: string): boolean {
  try {
    return existsSync(fileURLToPath(new URL('../../src/cli/index.ts', moduleUrl)));
  } catch {
    return false;
  }
}
