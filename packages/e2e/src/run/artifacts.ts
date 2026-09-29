/** Attempt-scoped artifact directory and report registration. */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import type { ArtifactStore } from '../types.ts';
import type { ArtifactRegistration, ArtifactSink } from './fixtures.ts';
import type { ArtifactRecord } from './records.ts';
import type { SessionSecrecy } from './secrecy.ts';

/**
 * How much of each kind the runner masked, unless the registration says. A
 * screenshot masks secure fields at the source; a log passes through the
 * secret redactor. A recording masks nothing: a secure field renders its own
 * dots, but anything else the screen showed is in the frames. A trace is
 * decided per attempt by whoever stops it (see `redactTraceArchives`): one
 * registered without that verdict was not rewritten, and says so. A download
 * is whatever the app served, bytes the runner did not write and does not
 * rewrite: it is `incomplete` unless the sink scanned it (see
 * `redactDownload`), so a store exporting only vouched-for artifacts holds it
 * back.
 */
const REDACTION_BY_KIND: Readonly<Record<ArtifactRecord['kind'], ArtifactRecord['redaction']>> = {
  screenshot: 'complete',
  trace: 'incomplete',
  video: 'incomplete',
  download: 'incomplete',
  log: 'complete',
};

/** Media types whose bytes are text the secret redactor can rewrite. */
function isTextLike(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json';
}

export interface AttemptArtifacts {
  /** Absolute attempt artifact directory, created eagerly. */
  readonly dir: string;
  /** Report-order artifact records; the sink appends to this array. */
  readonly records: ArtifactRecord[];
  readonly sink: ArtifactSink;
  /**
   * Resolves once every registered file has been measured and hashed.
   * Registration itself is synchronous and cheap; the size and digest of a
   * file (a trace zip can be tens of megabytes) are filled in off the event
   * loop, so awaiting this before the record is read is what makes them
   * complete.
   */
  settle(): Promise<void>;
}

/**
 * Creates the artifact directory for one attempt and a sink that registers
 * produced files under report-relative paths, measuring and hashing them
 * asynchronously. With a `store`, each complete artifact is also handed to it
 * right then — as produced, not at run end — and the store's reference lands
 * on the record as `ref`; a provider-hosted link goes to `putLink` the same
 * way, when the store has one.
 */
export function createAttemptArtifacts(options: {
  artifactsRoot: string;
  /** Report path segments, e.g. [targetName, sanitizedTestId, attempt-N]. */
  segments: readonly string[];
  attemptId: string;
  /** When provided, artifacts are attributed to the currently running step. */
  currentStepId?: () => string | undefined;
  /** Host store every artifact is handed to once complete; undefined keeps files local only. */
  store?: ArtifactStore;
  /**
   * The secrecy of the session the attempt runs on, read when a download is
   * registered; undefined (no session open yet) leaves every download as
   * served. Once a secret reached the session (filled, or held by the
   * engine), a text-like download is rewritten through its ledger before it
   * is hashed or stored.
   */
  secrecy?: () => SessionSecrecy | undefined;
  /**
   * Report identity handed to the store with each artifact. `attemptId` is
   * the attempt the REPORT files the artifact under; a serial member's
   * artifacts land on the group attempt's record, so its store identity is the
   * group's id while its own ids (`<attemptId>:artifact:N`) still mint from
   * the member. Defaults to `attemptId`.
   */
  identity?: { readonly runId: string; readonly testId: string; readonly attemptId?: string };
}): AttemptArtifacts {
  const dir = path.join(options.artifactsRoot, ...options.segments);
  mkdirSync(dir, { recursive: true });
  const records: ArtifactRecord[] = [];
  const pending: Promise<void>[] = [];

  const sink: ArtifactSink = {
    dir,
    register: (kind, relativePath, registration?: ArtifactRegistration) => {
      const id = `${options.attemptId}:artifact:${records.length}`;
      const absolute = path.join(dir, relativePath);
      const stepId = options.currentStepId?.();
      const startedAt = registration?.startedAt;
      const record: ArtifactRecord = {
        id,
        kind,
        mediaType: mediaTypeFor(relativePath),
        ...(startedAt === undefined ? {} : { startedAt }),
        redaction: registration?.redaction ?? REDACTION_BY_KIND[kind],
        producer: stepId === undefined ? { kind: 'attempt' } : { kind: 'step', stepId },
      };
      records.push(record);
      const reportPath = path.posix.join(...options.segments, relativePath);
      const secrecy: SessionSecrecy | undefined = kind === 'download' && registration?.redaction === undefined ? options.secrecy?.() : undefined;
      pending.push(
        (async () => {
          if (secrecy !== undefined && secrecy.exposure.redactsRecordings && isTextLike(record.mediaType)) {
            record.redaction = await redactDownload(absolute, secrecy);
          }
          // Without a store the file is streamed for its size and digest only;
          // with one it is read whole, since the store needs the bytes anyway,
          // and hashed from that same buffer. A file that never appeared is
          // recorded without size or digest either way.
          if (options.store === undefined) {
            const measured = await measure(absolute);
            if (measured === undefined) return;
            record.path = reportPath;
            record.size = measured.size;
            record.sha256 = measured.sha256;
            return;
          }
          const bytes = await readFile(absolute).catch(() => undefined);
          if (bytes === undefined) return;
          record.path = reportPath;
          record.size = bytes.byteLength;
          record.sha256 = createHash('sha256').update(bytes).digest('hex');
          // The store's failure is its own: the record keeps its local path and
          // simply carries no ref, and the run is never failed by evidence
          // that did not upload.
          try {
            const { ref } = await options.store.put({
              kind,
              mediaType: record.mediaType,
              bytes,
              size: record.size,
              sha256: record.sha256,
              path: reportPath,
              redaction: record.redaction,
              runId: options.identity?.runId ?? '',
              testId: options.identity?.testId ?? '',
              attemptId: options.identity?.attemptId ?? options.attemptId,
              ...(stepId === undefined ? {} : { stepId }),
              ...(startedAt === undefined ? {} : { startedAt }),
            });
            if (typeof ref === 'string' && ref !== '') record.ref = ref;
          } catch {
            // best-effort by contract
          }
        })(),
      );
      return id;
    },
    link: (url, link) => {
      const id = `${options.attemptId}:artifact:${records.length}`;
      const stepId = options.currentStepId?.();
      const record: ArtifactRecord = {
        id,
        kind: 'video',
        mediaType: link.mediaType,
        url,
        startedAt: link.startedAt,
        redaction: REDACTION_BY_KIND.video,
        producer: stepId === undefined ? { kind: 'attempt' } : { kind: 'step', stepId },
      };
      records.push(record);
      const putLink = options.store?.putLink;
      if (putLink !== undefined) {
        pending.push(
          (async () => {
            // Best-effort like `put`: the record keeps its URL either way.
            try {
              const { ref } = await putLink.call(options.store, {
                kind: 'video',
                url,
                mediaType: link.mediaType,
                redaction: 'incomplete',
                runId: options.identity?.runId ?? '',
                testId: options.identity?.testId ?? '',
                attemptId: options.identity?.attemptId ?? options.attemptId,
                startedAt: link.startedAt,
                ...(stepId === undefined ? {} : { stepId }),
              });
              if (typeof ref === 'string' && ref !== '') record.ref = ref;
            } catch {
              // best-effort by contract
            }
          })(),
        );
      }
      return id;
    },
  };

  const settle = async (): Promise<void> => {
    // Registrations may land while earlier ones are still hashing.
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };

  return { dir, records, sink, settle };
}

/**
 * Rewrites a text-like download through the session's ledger, the way a
 * trace's text entries are, and returns the redaction the record can claim:
 * `complete` once every registered value is gone from it, changed or not, and
 * `incomplete` when the file is not UTF-8 text or cannot be read or written,
 * in which case it is left as served. A leading byte order mark is kept as
 * part of the text, so a rewritten file starts the way it was served.
 */
async function redactDownload(absolute: string, secrecy: SessionSecrecy): Promise<ArtifactRecord['redaction']> {
  try {
    const bytes = await readFile(absolute);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const redacted = secrecy.ledger.redact(text);
    if (redacted !== text) await writeFileAtomic(absolute, redacted);
    return 'complete';
  } catch {
    return 'incomplete';
  }
}

/** Size and SHA-256 of one file, streamed; undefined when it cannot be read. */
async function measure(absolute: string): Promise<{ size: number; sha256: string } | undefined> {
  try {
    const { size } = await stat(absolute);
    const hash = createHash('sha256');
    await pipeline(createReadStream(absolute), hash);
    return { size, sha256: hash.digest('hex') };
  } catch {
    return undefined;
  }
}

/** Longest report path segment the runner writes: a name every common filesystem accepts. */
const MAX_SEGMENT_CHARS = 120;
/** Hex characters of the digest a rewritten or cut segment ends in. */
const SEGMENT_DIGEST_CHARS = 8;

/**
 * Restricts a report path segment to a safe filename alphabet and length. A
 * value that is already safe and within the cap is unchanged. Any other value
 * ends in a digest of the whole original: one the alphabet rewrote (a test id
 * with a `/`, a `::`, a percent-encoded space), one that is only dots (which
 * would name the directory or its parent), or one past the cap, which is cut
 * first. The digest is what keeps two ids that sanitize alike (`artifact%20a`
 * and `artifact_20a`, or two long ids with a shared prefix) in directories of
 * their own instead of writing over each other's evidence.
 */
export function sanitizePathSegment(value: string): string {
  const sanitized = /^\.+$/.test(value) ? '_' : value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  if (sanitized === value && sanitized.length <= MAX_SEGMENT_CHARS) return sanitized;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, SEGMENT_DIGEST_CHARS);
  return `${sanitized.slice(0, MAX_SEGMENT_CHARS - SEGMENT_DIGEST_CHARS - 1)}-${digest}`;
}

/** Longest slug of a label's first words that `labelSegment` keeps. */
const LABEL_SLUG_CHARS = 32;
/**
 * Hex characters of a label's digest. Labels that share their first words
 * differ only in it, and 32 bits collide within a short search, so a label
 * gets 64.
 */
const LABEL_DIGEST_CHARS = 16;
/** Latin letters NFKD leaves whole, spelled the way a slug reads them. */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  æ: 'ae', ð: 'd', đ: 'd', ı: 'i', ł: 'l', ø: 'o', œ: 'oe', ß: 'ss', þ: 'th',
};

/**
 * A short report path segment for free text such as an exploration goal:
 * `prefix`, a lowercase ASCII slug of the label's first words, and a digest
 * of the whole label, e.g. `explore-check-the-cart-totals-1a2b3c4d5e6f7a8b`. A
 * first word equal to the prefix is left out rather than said twice. The
 * slug is for reading only; the digest keeps two labels with the same first
 * words apart, and one label always maps to the same segment.
 */
export function labelSegment(prefix: string, label: string): string {
  // Accents come off first, so `café` reads `cafe` and `żółć` reads `zolc`, not words split at each accent.
  const ascii = label
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[æðđıłøœßþ]/g, (letter) => LATIN_LETTERS[letter] ?? letter);
  const words = ascii.split(/[^a-z0-9]+/).filter((word) => word !== '');
  if (words[0] === prefix) words.shift();
  let slug = words[0]?.slice(0, LABEL_SLUG_CHARS) ?? '';
  for (const word of words.slice(1)) {
    if (slug.length + 1 + word.length > LABEL_SLUG_CHARS) break;
    slug = `${slug}-${word}`;
  }
  const digest = createHash('sha256').update(label).digest('hex').slice(0, LABEL_DIGEST_CHARS);
  return [prefix, slug, digest].filter((part) => part !== '').join('-');
}

function mediaTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.png')) return 'image/png';
  if (relativePath.endsWith('.zip')) return 'application/zip';
  if (relativePath.endsWith('.webm')) return 'video/webm';
  if (relativePath.endsWith('.mp4')) return 'video/mp4';
  if (relativePath.endsWith('.txt')) return 'text/plain';
  if (relativePath.endsWith('.csv')) return 'text/csv';
  if (relativePath.endsWith('.json')) return 'application/json';
  if (relativePath.endsWith('.html') || relativePath.endsWith('.htm')) return 'text/html';
  return 'application/octet-stream';
}
