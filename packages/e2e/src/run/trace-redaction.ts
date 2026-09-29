/**
 * Runner-side redaction of the trace archives an engine wrote, before the
 * runner registers, hashes, or hands them to a store. An engine records what
 * happened, secrets included: a Playwright trace holds the filled value in the
 * action's parameters, in every DOM snapshot of the field, in the request
 * that carried it, and in the screencast frames of a field that shows it. The
 * runner owns the secret ledger, so the runner rewrites.
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
 * is thrown: the runner keeps no trace it cannot vouch for. A trace comes
 * here from a session a secret was filled on, whose pixels are withheld, so
 * its screencast frames are dropped as a screenshot would be denied; or from
 * one whose engine holds a secret in its options and where nothing was
 * filled, which the caller passes `keepFrames` for: an engine-held secret is
 * protected as text only.
 */
export async function redactTraceArchives(
  dir: string,
  paths: readonly string[],
  ledger: SecretLedger,
  options: { readonly keepFrames?: boolean } = {},
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
    for (const archive of archives) await redactArchive(archive, ledger, options.keepFrames === true);
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
 * rewritten at all. An entry that is not UTF-8 text (a font, an image) cannot
 * be rewritten: it is carried as stored unless a secret's bytes occur in it,
 * in which case it is dropped from the archive. Unless `keepFrames`,
 * screencast frames are dropped whatever they hold: every entry under
 * `screencast/`, referenced or not, the `screencast-frame` records in each
 * event stream (a `.trace` entry), and any other entry such a record names.
 */
async function redactArchive(absolute: string, ledger: SecretLedger, keepFrames: boolean): Promise<void> {
  const entries = readZip(await readFile(absolute));
  let changed = false;
  const kept: ZipEntry[] = [];
  const frames = new Set<string>();
  for (const entry of entries) {
    if (!keepFrames && entry.name.startsWith('screencast/')) {
      changed = true;
      continue;
    }
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
    const events = !keepFrames && entry.name.endsWith('.trace') ? withoutFrameRecords(text, frames) : text;
    const clean = redactText(events, ledger.redactFragments);
    if (clean === text) {
      kept.push(entry);
      continue;
    }
    changed = true;
    kept.push(zipEntry(entry.name, Buffer.from(clean, 'utf8'), entry));
  }
  if (changed) await writeFileAtomic(absolute, writeZip(kept.filter((entry) => !frames.has(entry.name))));
}

/**
 * An event stream without its `screencast-frame` records; the image each one
 * names joins `frames`. A record names it as `file`, or, in a trace older
 * than format 9, as a `sha1` under `resources/`. App content is JSON-escaped
 * inside the records that carry it, so only the trace's own records match.
 */
function withoutFrameRecords(text: string, frames: Set<string>): string {
  return text
    .split('\n')
    .filter((line) => {
      if (!line.includes('"screencast-frame"')) return true;
      let record: { type?: unknown; file?: unknown; sha1?: unknown } | null;
      try {
        record = JSON.parse(line);
      } catch {
        return true;
      }
      if (record?.type !== 'screencast-frame') return true;
      if (typeof record.file === 'string') frames.add(record.file);
      if (typeof record.sha1 === 'string') frames.add(`resources/${record.sha1}`);
      return false;
    })
    .join('\n');
}

/**
 * A trace's own members are JSON, one record per line; a resource is whatever
 * the page served. An entry whose every non-blank line parses as JSON is
 * redacted record by record, value by value, and a record is re-serialized
 * only when something changed, so a secret that happens to spell JSON syntax
 * cannot break one. Any other entry is redacted whole as text, so a value
 * that spans a line break, or matches across one as whitespace, is caught.
 */
function redactText(text: string, redact: (text: string) => string): string {
  const lines = text.split('\n');
  const records = lines.map((line) => (line.trim() === '' ? line : redactRecord(line, redact)));
  return records.every((record) => record !== undefined) ? records.join('\n') : redact(text);
}

/**
 * `line` redacted as one JSON record, or undefined when it is not one.
 * Numbers are carried as their source text (`JSON.rawJSON`), so an integer
 * past 2^53 or a negative zero survives the round trip untouched, and the
 * line's trailing whitespace (a CR before the LF) is kept as it was.
 */
function redactRecord(line: string, redact: (text: string) => string): string | undefined {
  if (!line.startsWith('{') && !line.startsWith('[')) return undefined;
  const body = line.trimEnd();
  let parsed: unknown;
  try {
    parsed = PARSE_WITH_SOURCE(body, (_key, value, context) =>
      typeof value === 'number' && context.source !== undefined ? RAW_JSON(context.source) : value,
    );
  } catch {
    return undefined;
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
