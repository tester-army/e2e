/** Optional file reads for `e2e init`. */

import { readFileSync } from 'node:fs';

/**
 * The file's text, or `undefined` when it is missing. A parent that is a file
 * (`ENOTDIR`) counts as missing, as `existsSync` treats it; any other read
 * failure throws.
 */
export function readIfPresent(absolute: string): string | undefined {
  try {
    return readFileSync(absolute, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw cause;
  }
}
