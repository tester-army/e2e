/** Where the `lightpanda` binary is when the config does not say. */

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const INSTALL_URL = 'https://lightpanda.io/docs/open-source/installation';
const NAME = 'lightpanda';
const PATH_VARIABLE = 'LIGHTPANDA_PATH';

/**
 * The binary to start: `LIGHTPANDA_PATH` when set, else `lightpanda` on
 * `PATH`, then the places the install guides and agent-browser put it,
 * `~/.lightpanda/lightpanda` and `~/.local/bin/lightpanda`. Throws, naming
 * the install page and `LIGHTPANDA_PATH`, when none exists.
 */
export function findBinary(env: Readonly<Record<string, string | undefined>>): string {
  const named = env[PATH_VARIABLE]?.trim();
  if (named !== undefined && named !== '') return named;
  const onPath = (env['PATH'] ?? '').split(path.delimiter).filter((dir) => dir !== '');
  const home = env['HOME'] ?? env['USERPROFILE'];
  const candidates = [
    ...onPath.map((dir) => path.join(dir, NAME)),
    ...(home === undefined ? [] : [path.join(home, '.lightpanda', NAME), path.join(home, '.local', 'bin', NAME)]),
  ];
  const found = candidates.find(isExecutable);
  if (found === undefined) {
    throw new Error(`lightpanda is not on PATH, in ~/.lightpanda, or in ~/.local/bin; install it (${INSTALL_URL}) or set ${PATH_VARIABLE}`);
  }
  return found;
}

/** A regular file the process may execute; a directory of that name on `PATH` is skipped. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
