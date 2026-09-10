/**
 * Runner-side redaction of the trace archives an engine wrote, before the
 * runner registers, hashes, or hands them to a store. An engine records what
 * happened, secrets included: a Playwright trace holds the filled value in the
 * action's parameters, in every DOM snapshot of the field, and in the request
 * that carried it. The runner owns the secret ledger, so the runner rewrites.
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { errorMessage, InfrastructureError } from '../internal/errors.ts';
import { inflateEntry, readZip, writeZip, zipEntry } from '../internal/zip.ts';

/**
 * Rewrites every archive of one trace through `redact`, in place. `relative`
 * is the path the engine returned for its trace; the archives beside it are
 * rewritten too, since an engine that had to cut its trace mid-attempt (a
 * replaced browser context) leaves the earlier segment there as well, and the
 * secret is in whichever segment saw the fill.
 *
 * An archive that cannot be rewritten is deleted, together with the rest of
 * the trace, and the failure is thrown: the runner keeps no trace it cannot
 * vouch for.
 */
export async function redactTraceArchives(
  dir: string,
  relative: string,
  redact: (text: string) => string,
): Promise<void> {
  const traceDir = path.join(dir, path.dirname(relative));
  const archives = (await readdir(traceDir))
    .filter((name) => name.endsWith('.zip'))
    .map((name) => path.join(traceDir, name));
  try {
    for (const archive of archives) await redactArchive(archive, redact);
  } catch (cause) {
    await Promise.all(archives.map((archive) => rm(archive, { force: true })));
    throw new InfrastructureError(
      'TRACE_WITHHELD',
      `the trace was deleted because it could not be redacted: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

/**
 * Every text entry passes through `redact`; an entry that is not UTF-8 text
 * (a screencast frame, a font, an image) is carried as stored, and so is a
 * text entry the redactor left unchanged, so an archive with nothing to
 * redact is not rewritten at all.
 */
async function redactArchive(absolute: string, redact: (text: string) => string): Promise<void> {
  const entries = readZip(await readFile(absolute));
  let changed = false;
  const redacted = entries.map((entry) => {
    const text = decodeText(inflateEntry(entry));
    if (text === undefined) return entry;
    const clean = redact(text);
    if (clean === text) return entry;
    changed = true;
    return zipEntry(entry.name, Buffer.from(clean, 'utf8'), entry);
  });
  if (changed) await writeFileAtomic(absolute, writeZip(redacted));
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The bytes as text when they are valid UTF-8 without NUL bytes; undefined for anything binary. */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = utf8.decode(bytes);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}
