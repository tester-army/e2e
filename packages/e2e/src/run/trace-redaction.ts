/**
 * Runner-side redaction of the trace archives an engine wrote, before the
 * runner registers, hashes, or hands them to a store. An engine records what
 * happened, secrets included: a Playwright trace holds the filled value in the
 * action's parameters, in every DOM snapshot of the field, and in the request
 * that carried it. The runner owns the secret ledger, so the runner rewrites.
 */

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { errorMessage, InfrastructureError } from '../internal/errors.ts';
import type { SecretLedger } from '../internal/redact.ts';
import { inflateEntry, readZip, writeZip, zipEntry, type ZipEntry } from '../internal/zip.ts';

/**
 * Rewrites the archives of one trace in place. `paths` are what the engine
 * returned from `stopTrace`, relative to `dir`; one that resolves outside
 * `dir` is refused before anything is touched. An archive that cannot be
 * rewritten is deleted together with the rest of the trace, and the failure
 * is thrown: the runner keeps no trace it cannot vouch for.
 */
export async function redactTraceArchives(
  dir: string,
  paths: readonly string[],
  ledger: SecretLedger,
): Promise<void> {
  const root = path.resolve(dir);
  const archives = paths.map((relative) => path.resolve(root, relative));
  const outside = archives.find((absolute) => !isInside(root, absolute));
  if (outside !== undefined) {
    throw new InfrastructureError(
      'TRACE_WITHHELD',
      `the trace was not registered: ${outside} is outside the attempt's artifact directory`,
    );
  }
  try {
    for (const archive of archives) await redactArchive(archive, ledger);
  } catch (cause) {
    await Promise.all(archives.map((archive) => rm(archive, { force: true })));
    throw new InfrastructureError(
      'TRACE_WITHHELD',
      `the trace was deleted because it could not be redacted: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

function isInside(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Every text entry is rewritten through the ledger, fragments of a value
 * included: the trace keeps what the engine read from the page raw, a text
 * cut at an observation limit partway through a secret or a selection over
 * part of one, which whole-value matching misses. One the redactor left
 * unchanged is carried as stored, so an archive with nothing to redact is not
 * rewritten at all. An entry that is not UTF-8 text (a screencast frame, a
 * font, an image) cannot be rewritten: it is carried as stored unless a
 * secret's bytes occur in it, in which case it is dropped from the archive.
 */
async function redactArchive(absolute: string, ledger: SecretLedger): Promise<void> {
  const entries = readZip(await readFile(absolute));
  let changed = false;
  const kept: ZipEntry[] = [];
  for (const entry of entries) {
    const bytes = inflateEntry(entry);
    const text = decodeText(bytes);
    if (text === undefined) {
      if (ledger.appearsIn(bytes)) {
        changed = true;
        continue;
      }
      kept.push(entry);
      continue;
    }
    const clean = redactText(text, ledger.redactFragments);
    if (clean === text) {
      kept.push(entry);
      continue;
    }
    changed = true;
    kept.push(zipEntry(entry.name, Buffer.from(clean, 'utf8'), entry));
  }
  if (changed) await writeFileAtomic(absolute, writeZip(kept));
}

/**
 * A trace's own members are JSON, one record per line; a resource is whatever
 * the page served. A line that parses as JSON is redacted value by value and
 * re-serialized only when something changed, so a secret that happens to
 * spell JSON syntax cannot break a record; any other line is redacted as text.
 */
function redactText(text: string, redact: (text: string) => string): string {
  return text
    .split('\n')
    .map((line) => redactLine(line, redact))
    .join('\n');
}

/**
 * Numbers are carried as their source text (`JSON.rawJSON`), so an integer
 * past 2^53 or a negative zero survives the round trip untouched, and the
 * line's trailing whitespace (a CR before the LF) is kept as it was.
 */
function redactLine(line: string, redact: (text: string) => string): string {
  if (!line.startsWith('{') && !line.startsWith('[')) return redact(line);
  const body = line.trimEnd();
  let parsed: unknown;
  try {
    parsed = PARSE_WITH_SOURCE(body, (_key, value, context) =>
      typeof value === 'number' && context.source !== undefined ? RAW_JSON(context.source) : value,
    );
  } catch {
    return redact(line);
  }
  const { value, changed } = redactValues(parsed, redact);
  return changed ? JSON.stringify(value) + line.slice(body.length) : line;
}

/**
 * `JSON.rawJSON` and the reviver's source-text argument (ES2025, Node 21+),
 * which the ES2023 lib does not type.
 */
const RAW_JSON = (JSON as unknown as { rawJSON(text: string): object }).rawJSON.bind(JSON);
const PARSE_WITH_SOURCE = JSON.parse as unknown as (
  text: string,
  reviver: (key: string, value: unknown, context: { source?: string }) => unknown,
) => unknown;

/** Redacts every string in a parsed JSON value, keys included; reports whether any changed. */
function redactValues(value: unknown, redact: (text: string) => string): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const clean = redact(value);
    return { value: clean, changed: clean !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = redactValues(item, redact);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const cleanKey = redact(key);
      const result = redactValues(item, redact);
      changed ||= cleanKey !== key || result.changed;
      return [cleanKey, result.value] as const;
    });
    return { value: changed ? Object.fromEntries(entries) : value, changed };
  }
  return { value, changed: false };
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
