/**
 * Which files the agent may attach to a file input. The model names a path;
 * the harness decides, before the engine sees it. Paths are project-relative,
 * like `locator.setInputFiles`, and a file a test author would not hand the
 * app is refused: one outside the project root (through a symlink too), one
 * that is hidden or sits under a hidden directory (`.env`, `.git`, `.e2e`),
 * one that does not exist or is not a regular file. A page can talk a model
 * into naming any path; it cannot talk the harness into reading it.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { MAX_TRACE_UPLOAD_PATHS } from '../cache/trace.ts';
import { TestError } from '../internal/errors.ts';
import { insideProjectRoot, realpathOfExisting } from '../internal/paths.ts';
import { AgentError } from './error.ts';

/** The paths as the executor gave them, and where each resolved to on disk. */
export interface AuthorizedUpload {
  readonly given: readonly string[];
  readonly resolved: readonly string[];
}

/**
 * Authorizes the paths of one upload against the project root. Malformed
 * input is `INVALID_ARGUMENT`; a path the policy refuses is `POLICY_DENIED`;
 * a path that names no regular file is `INVALID_ARGUMENT`, the ordinary
 * failure a model reads and corrects.
 */
export function authorizeUploadPaths(paths: unknown, projectRoot: string): AuthorizedUpload {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TestError('INVALID_ARGUMENT', 'upload requires one or more non-empty project-relative file paths');
  }
  if (paths.length > MAX_TRACE_UPLOAD_PATHS) {
    throw new TestError('INVALID_ARGUMENT', `upload takes at most ${String(MAX_TRACE_UPLOAD_PATHS)} files at once`);
  }
  const given = paths as readonly string[];
  const root = realpathOfExisting(projectRoot);
  const resolved = given.map((entry) => {
    const absolute = path.resolve(projectRoot, entry);
    if (!insideProjectRoot(projectRoot, absolute)) {
      throw new AgentError('POLICY_DENIED', `${JSON.stringify(entry)} is outside the project root; only files inside the project can be uploaded`);
    }
    const relative = path.relative(root, realpathOfExisting(absolute));
    if (relative.split(path.sep).some((segment) => segment.startsWith('.'))) {
      throw new AgentError('POLICY_DENIED', `${JSON.stringify(entry)} is a hidden file or sits under a hidden directory; those are never uploaded`);
    }
    let file;
    try {
      file = statSync(absolute);
    } catch {
      throw new TestError('INVALID_ARGUMENT', `no file at ${JSON.stringify(entry)} under the project root`);
    }
    if (!file.isFile()) throw new TestError('INVALID_ARGUMENT', `${JSON.stringify(entry)} is not a regular file`);
    return absolute;
  });
  return { given, resolved };
}
