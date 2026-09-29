/**
 * Paths resolved through the filesystem, for the checks that decide whether
 * a write stays inside the project.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** How many dangling symlinks one resolution follows, the limit Linux puts on one path lookup. */
const MAX_LINK_HOPS = 40;

/**
 * `target` with the symlinks of its deepest existing ancestor resolved and the
 * missing tail appended as written. A log file usually does not exist yet,
 * but the directory a symlink points at does, so this is what the runner
 * would actually open. A symlink whose target does not exist yet is followed
 * too, since a write through it lands where it points.
 */
export function realpathOfExisting(target: string): string {
  return resolveThroughLinks(target, 0);
}

/** `realpathOfExisting`, having followed `hops` dangling symlinks so far. */
function resolveThroughLinks(target: string, hops: number): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const pointsAt = hops < MAX_LINK_HOPS ? danglingLinkTarget(current) : undefined;
      if (pointsAt !== undefined) return resolveThroughLinks(path.join(pointsAt, ...tail), hops + 1);
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Where `entry` points when it is a symlink, resolved from its real parent directory; undefined for anything else. */
function danglingLinkTarget(entry: string): string | undefined {
  try {
    if (!lstatSync(entry).isSymbolicLink()) return undefined;
    return path.resolve(realpathSync(path.dirname(entry)), readlinkSync(entry));
  } catch {
    return undefined;
  }
}

/**
 * `target` relative to the project root once both are resolved through the
 * filesystem, or undefined when it is not strictly below the root: an
 * in-project symlink pointing outside is refused, a symlinked project root
 * still counts as the root, and a name that merely starts with `..`
 * (`..logs/out.log`) is an ordinary entry.
 */
export function relativeToProjectRoot(projectRoot: string, target: string): string | undefined {
  const relative = path.relative(realpathOfExisting(projectRoot), realpathOfExisting(target));
  const inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return inside ? relative : undefined;
}

/** Whether `target` is a path strictly below the project root; see `relativeToProjectRoot`. */
export function insideProjectRoot(projectRoot: string, target: string): boolean {
  return relativeToProjectRoot(projectRoot, target) !== undefined;
}
