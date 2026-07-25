/** Atomic report persistence (spec 13-reporting.md). */

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Atomically writes a wire JSON document with two-space indent and trailing newline. */
export async function writeJsonReport(filePath: string, document: unknown): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}
