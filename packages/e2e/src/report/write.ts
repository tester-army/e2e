/** Atomic report persistence. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';

/** Atomically writes one text document, creating the parent directory when it is missing. */
export async function writeTextReport(filePath: string, content: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content);
}

/** Atomically writes a wire JSON document with two-space indent and trailing newline. */
export async function writeJsonReport(filePath: string, document: unknown): Promise<void> {
  await writeTextReport(filePath, `${JSON.stringify(document, null, 2)}\n`);
}
