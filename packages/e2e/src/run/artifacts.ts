/** Attempt-scoped artifact directory and report registration. */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import type { ArtifactStore } from '../types.ts';
import type { ArtifactRegistration, ArtifactSink } from './fixtures.ts';
import type { ArtifactRecord } from './records.ts';
import { redactsDownloads, type SessionSecrecy } from './secrecy.ts';

/**
 * How much of each kind the runner masked. A
 * screenshot masks secure fields at the source; a log passes through the
 * secret redactor. A recording masks nothing: a secure field renders its own
 * dots, but anything else the screen showed is in the frames. A download
 * is whatever the app served, bytes the runner did not write and does not
 * rewrite: it is `incomplete` unless the sink scanned it (see
 * `redactDownload`), so a store exporting only vouched-for artifacts holds it
 * back.
 */
const REDACTION_BY_KIND: Readonly<Record<ArtifactRecord['kind'], ArtifactRecord['redaction']>> = {
  screenshot: 'complete',
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
   * file (a video can be tens of megabytes) are filled in off the event
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
  /** Report path segments, e.g. [resultSegment(result), attempt-N]. */
  segments: readonly string[];
  attemptId: string;
  /** When provided, artifacts are attributed to the currently running step. */
  currentStepId?: () => string | undefined;
  /** Host store every artifact is handed to once complete; undefined keeps files local only. */
  store?: ArtifactStore;
  /**
   * The secrecy of the session the attempt runs on, read when a download is
   * registered; undefined (no session open yet) leaves every download as
   * served. While its ledger holds a value (`redactsDownloads`), a
   * text-like download is rewritten through it before it is hashed or
   * stored.
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
        redaction: REDACTION_BY_KIND[kind],
        producer: stepId === undefined ? { kind: 'attempt' } : { kind: 'step', stepId },
      };
      records.push(record);
      const reportPath = path.posix.join(...options.segments, relativePath);
      const secrecy: SessionSecrecy | undefined = kind === 'download' ? options.secrecy?.() : undefined;
      pending.push(
        (async () => {
          if (secrecy !== undefined && redactsDownloads(secrecy) && isTextLike(record.mediaType)) {
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

/** What a `--last-failed` rerun's attempt directory is called, `rerun-<n>`, numbered from 1. */
const RERUN_DIR = /^rerun-([1-9][0-9]*)$/;

/**
 * Empties an artifact tree down to the files `keep` names, by their report
 * paths, and removes the directories left empty. A `--last-failed` rerun
 * starts this way rather than from an empty tree: the evidence the report it
 * reruns names stays, since that report's results fold into the rerun's and
 * its carried tests are not run again.
 */
export async function pruneArtifacts(root: string, keep: ReadonlySet<string>): Promise<void> {
  const prune = async (dir: string, relative: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw cause;
    }
    let empty = true;
    for (const entry of entries) {
      const reportPath = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await prune(absolute, reportPath)) await rmdir(absolute);
        else empty = false;
      } else if (keep.has(reportPath)) {
        empty = false;
      } else {
        await rm(absolute, { force: true });
      }
    }
    return empty;
  };
  await prune(root, '');
}

/**
 * The directory a `--last-failed` rerun's attempts write under inside each
 * test's directory, beside the evidence it kept: `rerun-<n>`, past every
 * number any test's directory already holds, so one rerun has one number
 * across the tree and no attempt of it writes into a directory an earlier
 * run's report still names.
 */
export async function nextRerunDir(root: string): Promise<string> {
  let taken = 0;
  for (const test of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!test.isDirectory()) continue;
    for (const name of await readdir(path.join(root, test.name))) taken = Math.max(taken, Number(RERUN_DIR.exec(name)?.[1] ?? 0));
  }
  return `rerun-${taken + 1}`;
}

/**
 * An attempt's report segments: its owner's directory (`resultSegment` of the
 * result, or of the serial group its members share), the rerun's directory on
 * a `--last-failed` rerun, and `attempt-<n>`, numbered from 1.
 */
export function attemptSegments(rerunDir: string | undefined, owner: string, attemptIndex: number): readonly string[] {
  return [owner, ...(rerunDir === undefined ? [] : [rerunDir]), `attempt-${attemptIndex + 1}`];
}

/**
 * Rewrites a text-like download through the session's ledger, and returns the redaction the record can claim:
 * `complete` once every registered value is gone from it, changed or not, and
 * `incomplete` when the file is not UTF-8 text or cannot be read or written,
 * in which case it is left as served. A leading byte order mark is kept as
 * part of the text, so a rewritten file starts the way it was served.
 */
async function redactDownload(absolute: string, secrecy: SessionSecrecy): Promise<ArtifactRecord['redaction']> {
  try {
    const bytes = await readFile(absolute);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const redacted = secrecy.ledger.redactFragments(text);
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

/** Characters of the test file's name a result's segment keeps. */
const MAX_FILE_SLUG_CHARS = 40;
/** Characters of the title's first words a result's segment keeps. */
const MAX_TITLE_SLUG_CHARS = 32;
/**
 * Hex characters of the result id a result's segment ends in. Results whose
 * file and first title words agree differ only in it, and 32 bits collide
 * within a short search, so it keeps 64.
 */
const RESULT_DIGEST_CHARS = 16;
/** Latin letters NFKD leaves whole, spelled the way a slug reads them. */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  æ: 'ae', ð: 'd', đ: 'd', ı: 'i', ł: 'l', ø: 'o', œ: 'oe', ß: 'ss', þ: 'th',
};

/**
 * The name a result goes by on disk, its trace page's and its artifact
 * directory's alike: the test file's name, a lowercase ASCII slug of the
 * title's first words, and the head of the result id, e.g.
 * `checkout-applies-the-coupon-1a2b3c4d5e6f7a8b`. A first title word equal to
 * the file's name is left out rather than said twice. The slugs are for
 * reading only; the id keeps two results with the same words (another
 * target, agent, or repeat) apart.
 */
export function resultSegment(result: { readonly id: string; readonly file: string; readonly titlePath: readonly string[] }): string {
  const file = path.posix
    .basename(result.file)
    .replace(/(\.e2e)?\.[cm]?[jt]sx?$/u, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_FILE_SLUG_CHARS);
  // Accents come off first, so `café` reads `cafe` and `żółć` reads `zolc`, not words split at each accent.
  const words = result.titlePath
    .join(' ')
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[æðđıłøœßþ]/g, (letter) => LATIN_LETTERS[letter] ?? letter)
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  if (words[0] === file) words.shift();
  let title = words[0]?.slice(0, MAX_TITLE_SLUG_CHARS) ?? '';
  for (const word of words.slice(1)) {
    if (title.length + 1 + word.length > MAX_TITLE_SLUG_CHARS) break;
    title = `${title}-${word}`;
  }
  return [file, title, result.id.slice(0, RESULT_DIGEST_CHARS)].filter((part) => part !== '').join('-');
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
