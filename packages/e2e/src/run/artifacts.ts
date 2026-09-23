/** Attempt-scoped artifact directory and report registration. */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { InfrastructureError } from '../internal/errors.ts';
import type { SecretLedger } from '../internal/redact.ts';
import type { ArtifactStore } from '../types.ts';
import type { ArtifactRegistration, ArtifactSink } from './fixtures.ts';
import type { ArtifactRecord } from './records.ts';

/**
 * How much of each kind the runner masked, unless the registration says. A
 * screenshot masks secure fields at the source; a log passes through the
 * secret redactor. A recording masks nothing: a secure field renders its own
 * dots, but anything else the screen showed is in the frames. A trace is
 * decided per attempt by whoever stops it (see `redactTraceArchives`): one
 * registered without that verdict was not rewritten, and says so. A download
 * is what the app served, so its bytes are scanned when the attempt settles:
 * one that holds a registered value is deleted and recorded without a path,
 * and a kept one earned its label.
 */
const REDACTION_BY_KIND: Readonly<Record<ArtifactRecord['kind'], ArtifactRecord['redaction']>> = {
  screenshot: 'complete',
  trace: 'incomplete',
  video: 'incomplete',
  download: 'complete',
  log: 'complete',
};

/** Kinds whose bytes come from the app and are scanned against the ledger before they are kept. */
const SCANNED_KINDS: ReadonlySet<ArtifactRecord['kind']> = new Set(['download']);

/** Size and SHA-256 of one file. */
interface Measured {
  readonly size: number;
  readonly sha256: string;
}

/** One registered file, as the sink knows it before its bytes are read. */
interface Produced {
  readonly record: ArtifactRecord;
  readonly kind: ArtifactRecord['kind'];
  readonly relativePath: string;
  readonly absolute: string;
  readonly reportPath: string;
  readonly stepId: string | undefined;
  readonly startedAt: string | undefined;
}

export interface AttemptArtifacts {
  /** Absolute attempt artifact directory, created eagerly. */
  readonly dir: string;
  /** Report-order artifact records; the sink appends to this array. */
  readonly records: ArtifactRecord[];
  readonly sink: ArtifactSink;
  /**
   * Resolves once every registered file has been measured and hashed, and
   * every download scanned against the ledger as it stands then.
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
 * right then — as produced, not at run end, a download once the attempt's scan
 * has cleared it — and the store's reference lands on the record as `ref`.
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
   * Report identity handed to the store with each artifact. `attemptId` is
   * the attempt the REPORT files the artifact under; a serial member's
   * artifacts land on the group attempt's record, so its store identity is the
   * group's id while its own ids (`<attemptId>:artifact:N`) still mint from
   * the member. Defaults to `attemptId`.
   */
  identity?: { readonly runId: string; readonly testId: string; readonly attemptId?: string };
  /**
   * The values a scanned kind must not carry, read when the attempt settles
   * so a value registered after the file was written counts.
   */
  ledger: () => SecretLedger;
  /**
   * Called when a scanned kind is registered, and returns where to report the
   * file should the scan withhold it. Registration is the moment the file was
   * produced; the scan runs at settle, when another phase may be running, and
   * the report attributes the loss to the former.
   */
  onWithheld?: () => (error: InfrastructureError) => void;
}): AttemptArtifacts {
  const dir = path.join(options.artifactsRoot, ...options.segments);
  mkdirSync(dir, { recursive: true });
  const records: ArtifactRecord[] = [];
  const pending: Promise<void>[] = [];
  const deferred: (() => Promise<void>)[] = [];

  /**
   * Records a file as kept and hands it to the store when there is one. The
   * store's failure is its own: the record keeps its local path and simply
   * carries no ref, and the run is never failed by evidence that did not
   * upload.
   */
  const keep = async (produced: Produced, measured: Measured, bytes: () => Promise<Buffer>): Promise<void> => {
    const { record } = produced;
    record.path = produced.reportPath;
    record.size = measured.size;
    record.sha256 = measured.sha256;
    if (options.store === undefined) return;
    try {
      const { ref } = await options.store.put({
        kind: produced.kind,
        mediaType: record.mediaType,
        bytes: await bytes(),
        size: measured.size,
        sha256: measured.sha256,
        path: produced.reportPath,
        runId: options.identity?.runId ?? '',
        testId: options.identity?.testId ?? '',
        attemptId: options.identity?.attemptId ?? options.attemptId,
        ...(produced.stepId === undefined ? {} : { stepId: produced.stepId }),
        ...(produced.startedAt === undefined ? {} : { startedAt: produced.startedAt }),
      });
      if (typeof ref === 'string' && ref !== '') record.ref = ref;
    } catch {
      // best-effort by contract
    }
  };

  /**
   * Measures a file the runner produced. A store needs the bytes, so the file
   * is read whole and hashed from that buffer; otherwise it is streamed for
   * its size and digest. A file that never appeared is recorded without size
   * or digest either way.
   */
  const measureProduced = async (produced: Produced): Promise<void> => {
    if (options.store === undefined) {
      const measured = await measure(produced.absolute);
      if (measured !== undefined) await keep(produced, measured, () => readFile(produced.absolute));
      return;
    }
    const bytes = await readFile(produced.absolute).catch(() => undefined);
    if (bytes !== undefined) await keep(produced, measuredFrom(bytes), () => Promise.resolve(bytes));
  };

  /**
   * The runner keeps no file it cannot vouch for: the bytes are the app's and
   * cannot be rewritten, so the file goes, and the record says why in place
   * of a path.
   */
  const withhold = async (produced: Produced, withheld: ((error: InfrastructureError) => void) | undefined): Promise<void> => {
    await rm(produced.absolute, { force: true });
    produced.record.redaction = 'incomplete';
    withheld?.(
      new InfrastructureError(
        'ARTIFACT_WITHHELD',
        `the ${produced.kind} ${produced.relativePath} was deleted because a registered secret value occurs in it`,
      ),
    );
  };

  /**
   * Scans a file the app produced against the ledger as it stands now and
   * keeps it only when no registered value occurs in it. Without a store the
   * file is streamed, so a large download is never held whole; a store needs
   * the bytes, so the file is read once and scanned from that buffer.
   */
  const scanProduced = async (produced: Produced, withheld: ((error: InfrastructureError) => void) | undefined): Promise<void> => {
    const ledger = options.ledger();
    if (options.store === undefined) {
      const scanned = await scanFile(produced.absolute, ledger);
      if (scanned === undefined) return;
      if (scanned.holds) await withhold(produced, withheld);
      else await keep(produced, scanned, () => readFile(produced.absolute));
      return;
    }
    const bytes = await readFile(produced.absolute).catch(() => undefined);
    if (bytes === undefined) return;
    if (ledger.appearsIn(bytes)) await withhold(produced, withheld);
    else await keep(produced, measuredFrom(bytes), () => Promise.resolve(bytes));
  };

  const sink: ArtifactSink = {
    dir,
    register: (kind, relativePath, registration?: ArtifactRegistration) => {
      const id = `${options.attemptId}:artifact:${records.length}`;
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
      const produced: Produced = {
        record,
        kind,
        relativePath,
        absolute: path.join(dir, relativePath),
        reportPath: path.posix.join(...options.segments, relativePath),
        stepId,
        startedAt,
      };
      if (SCANNED_KINDS.has(kind)) {
        // The app's bytes are judged when the attempt settles, against the
        // ledger as it stands then, so a value resolved after the file was
        // written counts; the phase to blame is the one producing it now.
        const withheld = options.onWithheld?.();
        deferred.push(() => scanProduced(produced, withheld));
      } else {
        pending.push(measureProduced(produced));
      }
      return id;
    },
  };

  const settle = async (): Promise<void> => {
    // Registrations may land while earlier ones are still hashing, and a
    // scan runs once everything registered before it has settled.
    while (pending.length > 0 || deferred.length > 0) {
      await Promise.all(pending.splice(0));
      await Promise.all(deferred.splice(0).map((scan) => scan()));
    }
  };

  return { dir, records, sink, settle };
}

function measuredFrom(bytes: Buffer): Measured {
  return { size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Size and SHA-256 of one file, streamed; undefined when it cannot be read. */
async function measure(absolute: string): Promise<Measured | undefined> {
  try {
    const { size } = await stat(absolute);
    const hash = createHash('sha256');
    await pipeline(createReadStream(absolute), hash);
    return { size, sha256: hash.digest('hex') };
  } catch {
    return undefined;
  }
}

/**
 * Size, SHA-256, and whether a registered value occurs, in one streamed pass
 * over a file the app produced, so a large download is never held whole in
 * the worker; undefined when it cannot be read.
 */
async function scanFile(absolute: string, ledger: SecretLedger): Promise<(Measured & { readonly holds: boolean }) | undefined> {
  try {
    const seen = ledger.byteScanner();
    const hash = createHash('sha256');
    let size = 0;
    let holds = false;
    for await (const piece of createReadStream(absolute)) {
      const bytes = piece as Buffer;
      size += bytes.byteLength;
      hash.update(bytes);
      holds = seen(bytes) || holds;
    }
    return { size, sha256: hash.digest('hex'), holds };
  } catch {
    return undefined;
  }
}

/** Longest report path segment the runner writes: a name every common filesystem accepts. */
const MAX_SEGMENT_CHARS = 120;
/** Hex characters of the digest a cut segment ends in. */
const SEGMENT_DIGEST_CHARS = 8;

/**
 * Restricts a report path segment to a safe filename alphabet and length. A
 * value that is only dots would name the directory or its parent, so it
 * becomes `_`. A value within the cap is unchanged. One past it is cut and
 * ends in a digest of the whole original, so two long test ids that share a
 * prefix (a monorepo path, a describe, a long title) get directories of
 * their own instead of writing over each other's evidence.
 */
export function sanitizePathSegment(value: string): string {
  if (/^\.+$/.test(value)) return '_';
  const sanitized = value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
  if (sanitized.length <= MAX_SEGMENT_CHARS) return sanitized;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, SEGMENT_DIGEST_CHARS);
  return `${sanitized.slice(0, MAX_SEGMENT_CHARS - SEGMENT_DIGEST_CHARS - 1)}-${digest}`;
}

function mediaTypeFor(relativePath: string): string {
  if (relativePath.endsWith('.png')) return 'image/png';
  if (relativePath.endsWith('.zip')) return 'application/zip';
  if (relativePath.endsWith('.webm')) return 'video/webm';
  if (relativePath.endsWith('.mp4')) return 'video/mp4';
  if (relativePath.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
