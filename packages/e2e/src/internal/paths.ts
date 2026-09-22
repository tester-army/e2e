/**
 * Paths resolved through the filesystem, for the checks that decide whether
 * a write stays inside the project.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * `target` with the symlinks of its deepest existing ancestor resolved and the
 * missing tail appended as written. A log file usually does not exist yet,
 * but the directory a symlink points at does, so this is what the runner
 * would actually open.
 */
export function realpathOfExisting(target: string): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `target` is a path strictly below the project root once both are
 * resolved through the filesystem: an in-project symlink pointing outside is
 * rejected, a symlinked project root still counts as the root, and a name
 * that merely starts with `..` (`..logs/out.log`) is an ordinary entry.
 */
export function insideProjectRoot(projectRoot: string, target: string): boolean {
  const relative = path.relative(realpathOfExisting(projectRoot), realpathOfExisting(target));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
