/** Filesystem custody and hosted filename checks, without directory scans. */
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';

/** A portable, unambiguous path inside an artifact directory. */
export function relativeArtifactPath(value: string): boolean {
  return value !== '' && !/[^a-zA-Z0-9_./-]/u.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** An original physical root and single-link file, not a mutable ancestor alias. */
export interface ArtifactFileAnchor {
  readonly root: string;
  readonly relative: string;
  readonly absolute: string;
  readonly rootInfo: Stats;
  readonly info: Stats;
}

/** Rejects the root entry itself as a link while permitting legitimate ancestor links. */
export function physicalArtifactRoot(root: string): { root: string; info: Stats } | undefined {
  const entry = lstatSync(path.resolve(root));
  if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
  const physical = realpathSync(root);
  const info = lstatSync(physical);
  return info.isDirectory() && !info.isSymbolicLink() && info.dev === entry.dev && info.ino === entry.ino ? Object.freeze({ root: physical, info: Object.freeze(info) }) : undefined;
}

/** Anchors a contained file; actual I/O errors propagate so absence is not confused with denial. */
export function anchorArtifactFile(root: string, relative: string): ArtifactFileAnchor | undefined {
  if (relative === '' || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
      relative.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined;
  const physical = physicalArtifactRoot(root);
  if (physical === undefined) return undefined;
  let current = physical.root;
  const segments = relative.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return undefined;
    if (index < segments.length - 1) { if (!info.isDirectory()) return undefined; }
    else if (info.isFile() && info.nlink === 1) return Object.freeze({ root: physical.root, rootInfo: physical.info, relative, absolute: current, info: Object.freeze(info) });
  }
  return undefined;
}

/** Checks the original descriptor's identity, size and mutation times. */
export function originalArtifactFile(info: Stats, original: Stats): boolean {
  return info.isFile() && info.nlink === 1 && info.dev === original.dev && info.ino === original.ino &&
    info.size === original.size && info.mtimeMs === original.mtimeMs && info.ctimeMs === original.ctimeMs;
}

/** Rechecks the physical root and descendants, never resolving through the original textual alias again. */
export function artifactAnchorCurrent(anchor: ArtifactFileAnchor): boolean {
  try {
    const current = anchorArtifactFile(anchor.root, anchor.relative);
    return current !== undefined && current.root === anchor.root && current.rootInfo.dev === anchor.rootInfo.dev && current.rootInfo.ino === anchor.rootInfo.ino && originalArtifactFile(current.info, anchor.info);
  } catch { return false; }
}

/** Hosted eligibility adds portable manifest names to filesystem custody. */
export function safeArtifactPath(root: string, relative: string): boolean {
  return relativeArtifactPath(relative) && containedArtifactFile(root, relative);
}

/** Refuses traversal, symlinks, hard links and non-files without hosted filename grammar. */
export function containedArtifactFile(root: string, relative: string): boolean {
  try { return anchorArtifactFile(root, relative) !== undefined; } catch { return false; }
}
