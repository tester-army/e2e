/** Atomic report persistence. */

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Atomically writes one text document: a sibling temporary file, then a rename. */
export async function writeTextReport(filePath: string, content: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
}

/** Atomically writes a wire JSON document with two-space indent and trailing newline. */
export async function writeJsonReport(filePath: string, document: unknown): Promise<void> {
  await writeTextReport(filePath, `${JSON.stringify(document, null, 2)}\n`);
}
