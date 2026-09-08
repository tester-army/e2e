/**
 * Atomic file replacement: the content goes to a sibling temporary file,
 * which is then renamed over the target, so a crash or a concurrent writer
 * cannot leave a torn file behind. The temporary name carries random bytes
 * rather than the pid and the clock: two writers racing on one path in the
 * same millisecond would otherwise pick the same name, and the first rename
 * would pull the file out from under the second.
 */

import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';

export interface AtomicWriteOptions {
  /** Mode for a file created by the write; the platform default when absent. */
  readonly mode?: number;
}

function temporaryPath(filePath: string): string {
  return `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
}

/** Writes `content` to `filePath` atomically; a failed write leaves no temporary file behind. */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporary = temporaryPath(filePath);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: options.mode });
    await rename(temporary, filePath);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

/** The synchronous twin, for a store that is read and written from synchronous code. */
export function writeFileAtomicSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
  const temporary = temporaryPath(filePath);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: options.mode });
    renameSync(temporary, filePath);
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw cause;
  }
}
