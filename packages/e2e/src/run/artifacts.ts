/** Attempt-scoped artifact directory and report registration. */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactSink } from './fixtures.ts';
import type { ArtifactRecord } from './records.ts';

export interface AttemptArtifacts {
  /** Absolute attempt artifact directory, created eagerly. */
  readonly dir: string;
  /** Report-order artifact records; the sink appends to this array. */
  readonly records: ArtifactRecord[];
  readonly sink: ArtifactSink;
}

/**
 * Creates the artifact directory for one attempt and a sink that stats,
 * hashes, and registers produced files under report-relative paths.
 */
export function createAttemptArtifacts(options: {
  artifactsRoot: string;
  /** Report path segments, e.g. [targetName, sanitizedTestId, attempt-N]. */
  segments: readonly string[];
  attemptId: string;
  /** When provided, artifacts are attributed to the currently running step. */
  currentStepId?: () => string | undefined;
}): AttemptArtifacts {
  const dir = path.join(options.artifactsRoot, ...options.segments);
  mkdirSync(dir, { recursive: true });
  const records: ArtifactRecord[] = [];

  const sink: ArtifactSink = {
    register: (kind, relativePath) => {
      const id = `${options.attemptId}:artifact:${records.length}`;
      const absolute = path.join(dir, relativePath);
      let size: number | undefined;
      let digest: string | undefined;
      try {
        size = statSync(absolute).size;
        digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      } catch {
        // artifact may not exist yet; recorded without size/digest
      }
      const stepId = options.currentStepId?.();
      records.push({
        id,
        kind,
        mediaType: mediaTypeFor(relativePath),
        ...(size !== undefined && digest !== undefined
          ? { path: path.posix.join(...options.segments, relativePath), size, sha256: digest }
          : {}),
        redaction: 'complete',
        producer: stepId === undefined ? { kind: 'attempt' } : { kind: 'step', stepId },
      });
      return id;
    },
  };

  return { dir, records, sink };
}

/** Restricts a report path segment to a safe filename alphabet. */
export function sanitizePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._\-]/g, '_').slice(0, 120);
}

function mediaTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.png')) return 'image/png';
  if (relativePath.endsWith('.zip')) return 'application/zip';
  if (relativePath.endsWith('.webm')) return 'video/webm';
  return 'application/octet-stream';
}
