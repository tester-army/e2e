/** Bounded snapshots of runner-authorized files for inspectable browser uploads. */

import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'mime-types';
import { EngineError } from 'e2e/engine';
import type { ConnectionBudget } from './operation-budget.ts';
import { withConnectionBudget } from './operation-budget.ts';

/** Path mode preserves Playwright's disk-backed behavior, including large files. */
export type FileUploadMode = 'path' | 'buffered';

interface BufferedFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

const MAX_BUFFERED_BYTES = 2_000_000;
const MAX_BUFFERED_FILES = 32;

/** A fixed message keeps paths, file contents and filesystem errors out of observations. */
function refused(): EngineError {
  return new EngineError('NOT_ACTIONABLE', 'buffered upload requires at most 32 unchanged regular files totaling at most 2000000 bytes', { retryable: false });
}

/**
 * Reads the selected paths, never an expected test body. The resulting immutable
 * buffers go to Playwright's native setInputFiles/setFiles API, not HTTP replay.
 */
export async function prepareUploadFiles(paths: readonly string[], mode: FileUploadMode, operation: ConnectionBudget): Promise<string[] | BufferedFile[]> {
  if (mode === 'path') return [...paths];
  if (paths.length > MAX_BUFFERED_FILES) throw refused();
  return withConnectionBudget(operation, 'buffered file upload', async remaining => {
    const files: BufferedFile[] = [];
    let total = 0;
    for (const given of paths) {
      remaining();
      const selected = path.resolve(given);
      // No-follow/nonblocking prevents a replaced symlink or pipe from turning
      // a bounded read into a different file or an unbounded wait.
      const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw refused(); });
      try {
        remaining();
        const before = await handle.stat();
        remaining();
        if (!before.isFile() || before.size > MAX_BUFFERED_BYTES - total) throw refused();
        const buffer = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          remaining();
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          remaining();
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const after = await handle.stat();
        const named = await lstat(selected);
        remaining();
        if (offset !== before.size || !named.isFile() ||
            before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size || before.mtimeMs !== named.mtimeMs || before.ctimeMs !== named.ctimeMs) throw refused();
        const contents = buffer.subarray(0, offset);
        const name = path.basename(selected);
        const mimeType = lookup(name) || 'application/octet-stream';
        if (mimeType === 'application/pdf' && !contents.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw refused();
        files.push({ name, mimeType, buffer: contents });
        total += offset;
      } catch (cause) {
        if (cause instanceof EngineError) throw cause;
        throw refused();
      } finally {
        await handle.close().catch(() => { throw refused(); });
      }
      remaining();
    }
    return files;
  });
}
