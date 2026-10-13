/** Attempt-scoped artifact directory and report registration. */

import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, mkdirSync, openSync } from 'node:fs';
import { open, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import type { ArtifactStore } from '../types.ts';
import type { ArtifactRegistration, ArtifactSink } from './fixtures.ts';
import type { ArtifactRecord } from './records.ts';
import { anchorArtifactFile, artifactAnchorCurrent, originalArtifactFile, physicalArtifactRoot, relativeArtifactPath, safeArtifactPath, type ArtifactFileAnchor } from './artifact-path.ts';
import { checkpointUnavailableBytesProven, type CheckpointUnavailableFacts } from './checkpoint-unavailable.ts';
import { redactsDownloads, prospectiveSecretResolutionsProven, type SessionSecrecy } from './secrecy.ts';

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
  /** Evidence registered by the runner, not arbitrary engine fixture attachments. */
  readonly debugEvidence: ReadonlySet<string>;
  /** Original registered locations, never inferred from artifact IDs or filenames. */
  readonly debugPaths: ReadonlyMap<string, string>;
  /** Original registered file identity, distinct from content permission. */
  readonly debugFiles: ReadonlyMap<string, ArtifactFileAnchor>;
  /** Owned capture associations, separate from report or public engine metadata. */
  readonly debugCheckpoints: ReadonlyMap<string, DebugCheckpointAssociation>;
  /** Capture-time ledger proof, rechecked at export. Neither filenames nor pixels can be repaired retrospectively. */
  debugRedactionProven(id: string): boolean;
  /** Original SDK-ticket media fact, verified against registered bytes; never caller or filename authority. */
  debugMediaType(id: string): string | undefined;
  /** Distinct closed SDK missing-checkpoint bytes, never generic content permission. */
  debugUnavailableProven(id: string): boolean;
  /**
   * Resolves once every registered file has been measured and hashed.
   * Registration itself is synchronous and cheap; the size and digest of a
   * file (a video can be tens of megabytes) are filled in off the event
   * loop, so awaiting this before the record is read is what makes them
   * complete.
   */
  settle(): Promise<void>;
}

/** Private association copied from an actual checkpoint capture, never parsed from IDs. */
export interface DebugCheckpointAssociation {
  readonly checkpointId: string;
  readonly phase: "before" | "after";
  readonly observationId: string | null;
  readonly observationRevision: string | null;
}
type DebugEvidenceKind = "pixels" | "text" | "checkpoint-json" | "checkpoint-unavailable";
interface DebugRedactionProof {
  readonly secrecy: SessionSecrecy;
  readonly values: number;
  readonly complete: boolean;
}
interface DebugTicket {
  readonly sink: ArtifactSink;
  readonly kind: DebugEvidenceKind;
  readonly proof: DebugRedactionProof | undefined;
  checkpoint?: DebugCheckpointAssociation;
  stepId?: string;
  startedAt?: string;
  invalid?: boolean;
  expected?: { readonly size: number; readonly sha256: string };
  file?: ArtifactFileAnchor;
}
const debugSinks = new WeakMap<ArtifactSink, { readonly attemptId: string; readonly proof: () => DebugRedactionProof | undefined }>();
const debugRegistrations = new WeakMap<ArtifactRegistration, DebugTicket>();
const consumedDebugRegistrations = new WeakSet<ArtifactRegistration>();

/** Begins SDK pixel/text proof before capture, or checkpoint JSON proof after final field redaction. */
export function debugEvidenceRegistration(sink: ArtifactSink, kind: DebugEvidenceKind = "pixels", checkpoint?: {
  readonly association: DebugCheckpointAssociation;
  readonly facts: Pick<ArtifactRegistration, "stepId" | "startedAt">;
}): ArtifactRegistration {
  const registration: ArtifactRegistration = { debugEvidence: true };
  debugRegistrations.set(registration, { sink, kind, proof: debugSinks.get(sink)?.proof() });
  return checkpoint === undefined ? registration : associateDebugCheckpoint(registration, checkpoint.association, checkpoint.facts);
}

/** Binds owned bounded identity without cloning the original capture ticket. */
export function associateDebugCheckpoint(registration: ArtifactRegistration, association: DebugCheckpointAssociation, facts: Pick<ArtifactRegistration, "stepId" | "startedAt">): ArtifactRegistration {
  const ticket = debugRegistrations.get(registration);
  if (ticket === undefined) return registration;
  const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
  const optionalIdentity = (value: unknown): boolean => value === null || identity(value);
  if (association === null || typeof association !== "object" || Array.isArray(association) || ticket.checkpoint !== undefined || !identity(association.checkpointId) || !["before", "after"].includes(association.phase) ||
      !optionalIdentity(association.observationId) || !optionalIdentity(association.observationRevision) ||
      (association.observationId === null) !== (association.observationRevision === null)) {
    ticket.invalid = true;
    return registration;
  }
  if (facts === null || typeof facts !== "object" || !identity(facts.stepId)) { ticket.invalid = true; return registration; }
  ticket.stepId = facts.stepId;
  if (facts.startedAt !== undefined) ticket.startedAt = facts.startedAt;
  ticket.checkpoint = Object.freeze({ checkpointId: association.checkpointId, phase: association.phase, observationId: association.observationId, observationRevision: association.observationRevision });
  Object.assign(registration, facts);
  return registration;
}

/** Binds expected producer bytes once to an original sink-owned capture ticket, not public metadata. */
export function bindDebugEvidenceBytes(sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array): void {
  const ticket = debugRegistrations.get(registration);
  if (ticket?.sink !== sink || ticket.invalid === true) return;
  if (ticket.expected !== undefined) { ticket.invalid = true; return; }
  ticket.expected = Object.freeze({ size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
}

/**
 * Holds the capture-return descriptor before the first yield, then hashes the
 * original file in 64KiB chunks. Byte custody never grants content permission.
 * Cancellation fences new work; it cannot retract already issued OS I/O.
 */
export async function bindDebugEvidenceFile(sink: ArtifactSink, relative: string, registration: ArtifactRegistration, signal?: AbortSignal, deadline = Infinity): Promise<string> {
  const ticket = debugRegistrations.get(registration);
  if (ticket?.sink !== sink || ticket.invalid === true) return relative;
  if (ticket.expected !== undefined || signal?.aborted || Date.now() >= deadline) { ticket.invalid = true; return relative; }
  let file: number | undefined;
  let stream: ReturnType<typeof createReadStream> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const anchor = anchorArtifactFile(sink.dir, relative);
    if (anchor === undefined) { ticket.invalid = true; return relative; }
    file = openSync(anchor.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(file);
    if (!originalArtifactFile(info, anchor.info) || !artifactAnchorCurrent(anchor)) { ticket.invalid = true; return relative; }
    ticket.file = anchor;
    const hash = createHash('sha256');
    let size = 0;
    stream = createReadStream(anchor.absolute, { fd: file, autoClose: false, highWaterMark: 65536, ...(signal === undefined ? {} : { signal }) });
    const cancelled = new Promise<void>((resolve) => {
      cancel = () => {
        ticket.invalid = true;
        stream!.destroy();
        resolve();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (Number.isFinite(deadline)) {
        const arm = (): void => {
          timer = setTimeout(() => {
            if (Date.now() >= deadline) cancel!();
            else arm();
          }, Math.min(2147483647, Math.max(0, deadline - Date.now())));
        };
        arm();
      }
      if (signal?.aborted) cancel();
    });
    const binding = (async () => {
      for await (const chunk of stream!) {
        if (ticket.invalid === true || signal?.aborted || Date.now() >= deadline) throw new Error('evidence binding ended');
        size += chunk.length;
        hash.update(chunk);
      }
      if (ticket.invalid === true || signal?.aborted || Date.now() >= deadline || size !== info.size || !originalArtifactFile(fstatSync(file!), info) || !artifactAnchorCurrent(anchor)) {
        ticket.invalid = true; return;
      }
      // Capture-start proof is retained as-is and rechecked by the sink after IO,
      // including opaque files whose original MIME/bytes remain truthful facts.
      ticket.expected = Object.freeze({ size, sha256: hash.digest('hex') });
    })();
    // Node destruction waits for pending IO; abandonment must not wait for its callback.
    // The race observes late rejection, and the invalid ticket fences late proof creation.
    await Promise.race([binding, cancelled]);
    return relative;
  } catch { ticket.invalid = true; return relative; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
    if (stream !== undefined) {
      // The stream owns the FD even during destruction: Node waits for pending
      // reads before closing it. autoClose:false keeps EOF open for final fstat.
      stream.close((error) => { if (error) ticket.invalid = true; });
    } else if (file !== undefined) closeSync(file);
  }
}

/** Rechecks the original SDK ticket before any retained pixels leave memory. */
export function debugEvidenceProven(sink: ArtifactSink, registration: ArtifactRegistration): boolean {
  const ticket = debugRegistrations.get(registration);
  return ticket?.sink === sink && ticket.invalid !== true && debugProofValid(ticket.proof, ticket.kind);
}

/** Checks original unconsumed byte custody AND closed SDK-facts permission before first persistence. */
export function debugEvidenceBytesProven(sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array): boolean {
  const ticket = debugRegistrations.get(registration);
  const expected = ticket?.expected;
  return debugEvidenceProven(sink, registration) && expected !== undefined && expected.size === bytes.byteLength &&
    expected.sha256 === createHash('sha256').update(bytes).digest('hex') &&
    (ticket?.kind !== "checkpoint-unavailable" || unavailableBytesProven(sink, ticket, bytes));
}

/** Reads attempt identity from the existing sink context, never supplied JSON or mutable registration facts. */
function unavailableFacts(sink: ArtifactSink, ticket: DebugTicket): CheckpointUnavailableFacts | undefined {
  const context = debugSinks.get(sink);
  return context === undefined || ticket.sink !== sink ? undefined : {
    attemptId: context.attemptId, stepId: ticket.stepId, attemptedAt: ticket.startedAt, association: ticket.checkpoint,
  };
}

/** Byte format and live owning secrecy are separate required permissions, even with a matching digest. */
function unavailableBytesProven(sink: ArtifactSink, ticket: DebugTicket, bytes: Uint8Array): boolean {
  return ticket.invalid !== true && ticket.proof?.secrecy === debugSinks.get(sink)?.proof()?.secrecy &&
    debugProofValid(ticket.proof, ticket.kind) && checkpointUnavailableBytesProven(bytes, unavailableFacts(sink, ticket));
}

/** Checks live secrecy without provider calls, new waits or retrospective pixel repair. */
function debugProofValid(proof: DebugRedactionProof | undefined, kind: DebugEvidenceKind): boolean {
  if (proof === undefined) return false;
  if (kind === "checkpoint-unavailable") return prospectiveSecretResolutionsProven(proof.secrecy.ledger, "sdk-facts");
  return proof.complete && prospectiveSecretResolutionsProven(proof.secrecy.ledger) &&
    proof.values === proof.secrecy.ledger.entries().length && (kind !== "pixels" || !proof.secrecy.exposure.withholdsPixels);
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
  /** Hosted exports never read a registered file outside the attempt or through a symlink. */
  safePaths?: boolean;
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
  const requestedDir = path.join(options.artifactsRoot, ...options.segments);
  mkdirSync(requestedDir, { recursive: true });
  const dir = physicalArtifactRoot(requestedDir)?.root ?? requestedDir;
  const records: ArtifactRecord[] = [];
  const pending: Promise<void>[] = [];
  const debugEvidence = new Set<string>();
  const debugPaths = new Map<string, string>();
  const debugFiles = new Map<string, ArtifactFileAnchor>();
  const debugCheckpoints = new Map<string, DebugCheckpointAssociation>();
  const debugMedia = new Map<string, { readonly mediaType: string; readonly kind: ArtifactRecord['kind']; readonly producer: ArtifactRecord['producer']; readonly size: number; readonly sha256: string }>();
  const debugProofs = new Map<string, { readonly proof: DebugRedactionProof | undefined; readonly kind: DebugEvidenceKind; readonly valid: boolean; bytesValid?: boolean; protocolValid?: boolean }>();

  const sink: ArtifactSink = {
    dir,
    register: (kind, relativePath, registration?: ArtifactRegistration) => {
      const id = `${options.attemptId}:artifact:${records.length}`;
      const absolute = path.join(dir, relativePath);
      const ticket = registration === undefined ? undefined : debugRegistrations.get(registration);
      if (ticket?.sink === sink && ticket.file === undefined && ticket.expected !== undefined) {
        try { const file = anchorArtifactFile(dir, relativePath); if (file !== undefined) ticket.file = file; } catch { /* absent or unreadable */ }
      }
      if (ticket?.file !== undefined) debugFiles.set(id, ticket.file);
      const consumed = registration !== undefined && consumedDebugRegistrations.has(registration);
      const legacyProof = registration?.debugEvidence === true && ticket === undefined && !consumed ? debugSinks.get(sink)?.proof() : undefined;
      const stepId = ticket?.sink === sink && ticket.checkpoint !== undefined ? ticket.stepId : options.currentStepId?.();
      const startedAt = ticket?.sink === sink && ticket.checkpoint !== undefined ? ticket.startedAt : registration?.startedAt;
      const record: ArtifactRecord = {
        id,
        kind,
        mediaType: mediaTypeFor(relativePath),
        ...(startedAt === undefined ? {} : { startedAt }),
        redaction: REDACTION_BY_KIND[kind],
        producer: stepId === undefined ? { kind: 'attempt' } : { kind: 'step', stepId },
      };
      // Store redaction and private export admission are different axes. An
      // unsupported custom picture keeps legacy metadata when its live secrecy
      // is proven, but a bare marker cannot authorize hosted evidence.
      if (registration?.debugEvidence === true) {
        const secrecy = options.secrecy?.();
        if (consumed || (ticket !== undefined ? !debugEvidenceProven(sink, registration)
          : secrecy === undefined || !prospectiveSecretResolutionsProven(secrecy.ledger) || kind === 'screenshot' && secrecy.exposure.withholdsPixels)) {
          record.redaction = 'incomplete';
        }
      }
      if (registration !== undefined) {
        debugRegistrations.delete(registration);
        if (ticket !== undefined) consumedDebugRegistrations.add(registration);
      }
      records.push(record);
      debugPaths.set(id, relativePath);
      if (registration?.debugEvidence === true) {
        const valid = ticket?.sink === sink && ticket.invalid !== true &&
          (ticket.kind === "checkpoint-unavailable" ? kind === "log" && record.mediaType === "application/json" && ticket.checkpoint?.observationId === null && ticket.checkpoint.observationRevision === null
            : ticket.kind === "checkpoint-json" ? kind === "log" && record.mediaType === "application/json" && ticket.checkpoint !== undefined
            : ticket.kind === "text" ? kind === "log" : kind === "screenshot") &&
          (ticket.checkpoint === undefined || (stepId !== undefined && (kind !== "screenshot" || record.mediaType === "image/png")));
        debugProofs.set(id, { proof: ticket?.proof, kind: ticket?.kind ?? "pixels", valid });
        if (valid) {
          debugEvidence.add(id);
          if (ticket.checkpoint !== undefined) debugCheckpoints.set(id, ticket.checkpoint);
        }
      }
      const reportPath = path.posix.join(...options.segments, relativePath);
      const secrecy: SessionSecrecy | undefined = kind === 'download' ? options.secrecy?.() : undefined;
      pending.push(
        (async () => {
          if (options.safePaths === true && !safeArtifactPath(dir, relativePath)) {
            record.redaction = 'incomplete';
            return;
          }
          if (secrecy !== undefined && redactsDownloads(secrecy) && isTextLike(record.mediaType)) {
            record.redaction = await redactDownload(absolute, secrecy);
          }
          const mediaKind = debugEvidence.has(id) ? ticket?.kind : undefined;
          const matchesExpected = (measured: { size: number; sha256: string }): boolean => {
            if (ticket === undefined && !consumed) return true;
            const expected = ticket?.expected;
            const proof = debugProofs.get(id);
            const matches = !consumed && ticket?.sink === sink && ticket.invalid !== true && proof?.valid === true &&
              expected !== undefined && expected.size === measured.size && expected.sha256 === measured.sha256 &&
              ticket.file !== undefined && artifactAnchorCurrent(ticket.file);
            if (proof !== undefined) proof.bytesValid = matches;
            if (!matches) record.redaction = 'incomplete';
            return matches;
          };
          // Neither async path may keep a complete label after its live proof changed.
          // The legacy snapshot checks secrecy only; it never becomes a private ticket.
          const revalidateRedaction = (): boolean => {
            const unsafeLegacy = registration?.debugEvidence === true && ticket === undefined &&
              (consumed || options.secrecy?.() !== legacyProof?.secrecy || !debugProofValid(legacyProof, kind === 'screenshot' ? 'pixels' : 'text'));
            const unsafeTicket = ticket !== undefined && !debugProofValid(ticket.proof, ticket.kind) &&
              (ticket.proof?.complete === true || ticket.kind === 'pixels');
            if (!unsafeLegacy && !unsafeTicket) return true;
            record.redaction = 'incomplete';
            return false;
          };
          const authorizeUnavailable = (bytes: Uint8Array | undefined): boolean => {
            if (ticket?.kind !== "checkpoint-unavailable") return true;
            const proof = debugProofs.get(id);
            const valid = proof?.valid === true && bytes !== undefined && unavailableBytesProven(sink, ticket, bytes);
            if (proof !== undefined) proof.protocolValid = valid;
            if (!valid) {
              if (proof !== undefined) proof.bytesValid = false;
              record.redaction = 'incomplete';
            }
            return valid;
          };
          const mediaFact = (mediaType: string): void => {
            if (record.mediaType === mediaType && record.size !== undefined && record.sha256 !== undefined) debugMedia.set(id, { mediaType, kind, producer: { ...record.producer }, size: record.size, sha256: record.sha256 });
          };
          // SDK semantic text/JSON is checked and hashed from the same buffer.
          // Pixels need only the PNG header alongside streaming measurement.
          // With a store, its original bytes also supply the media and digest.
          // Absent files carry no size, digest or byte-verified media fact.
          if (options.store === undefined) {
            // SDK-facts require the entire exact protocol buffer, including ordinary non-hosted sinks.
            const unavailableBytes = ticket?.kind === "checkpoint-unavailable"
              ? (options.safePaths === true || ticket !== undefined) ? await readHosted(dir, relativePath, ticket?.file, options.safePaths === true) : await readFile(absolute).catch(() => undefined)
              : undefined;
            const measured = ticket?.kind === "checkpoint-unavailable"
              ? unavailableBytes === undefined ? undefined : { size: unavailableBytes.byteLength, sha256: createHash('sha256').update(unavailableBytes).digest('hex'), mediaType: 'application/json' }
              : (options.safePaths === true || ticket !== undefined) ? await measureHosted(dir, relativePath, mediaKind, ticket?.file, options.safePaths === true) : await measure(absolute);
            revalidateRedaction();
            if (measured === undefined && ticket !== undefined) {
              record.redaction = 'incomplete';
              const proof = debugProofs.get(id);
              if (proof !== undefined) proof.bytesValid = false;
            }
            if (!authorizeUnavailable(unavailableBytes) || measured === undefined || !matchesExpected(measured)) return;
            record.path = reportPath;
            record.size = measured.size;
            record.sha256 = measured.sha256;
            if ('mediaType' in measured && typeof measured.mediaType === 'string') mediaFact(measured.mediaType);
            return;
          }
          const bytes = (options.safePaths === true || ticket !== undefined) ? await readHosted(dir, relativePath, ticket?.file, options.safePaths === true) : await readFile(absolute).catch(() => undefined);
          const publicationIsProven = revalidateRedaction();
          if (bytes === undefined && ticket !== undefined) {
            record.redaction = 'incomplete';
            const proof = debugProofs.get(id);
            if (proof !== undefined) proof.bytesValid = false;
          }
          if (!authorizeUnavailable(bytes) || bytes === undefined) return;
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (!matchesExpected({ size: bytes.byteLength, sha256 })) return;
          record.path = reportPath;
          record.size = bytes.byteLength;
          record.sha256 = sha256;
          const media = verifiedDebugMedia(bytes, mediaKind, ticket === undefined ? undefined : unavailableFacts(sink, ticket));
          if (media !== undefined) mediaFact(media);
          if (!publicationIsProven) return;
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

  debugSinks.set(sink, Object.freeze({ attemptId: options.attemptId, proof: () => {
    const secrecy = options.secrecy?.();
    return secrecy === undefined ? undefined : {
      secrecy, values: secrecy.ledger.entries().length, complete: prospectiveSecretResolutionsProven(secrecy.ledger),
    };
  } }));

  const settle = async (): Promise<void> => {
    // Registrations may land while earlier ones are still hashing.
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };

  return {
    dir, records, sink, settle, debugEvidence, debugPaths, debugFiles, debugCheckpoints,
    debugMediaType: (id) => {
      const fact = debugMedia.get(id);
      const record = records.find((candidate) => candidate.id === id);
      return fact !== undefined && record?.kind === fact.kind && record.mediaType === fact.mediaType && record.size === fact.size && record.sha256 === fact.sha256 &&
        record.producer.kind === fact.producer.kind &&
        (record.producer.kind !== 'step' || fact.producer.kind === 'step' && record.producer.stepId === fact.producer.stepId)
        ? fact.mediaType : undefined;
    },
    debugUnavailableProven: (id) => {
      const entry = debugProofs.get(id);
      return entry?.kind === "checkpoint-unavailable" && entry.valid && entry.bytesValid === true && entry.protocolValid === true &&
        entry.proof?.secrecy === debugSinks.get(sink)?.proof()?.secrecy &&
        debugProofValid(entry.proof, entry.kind) && debugMedia.get(id)?.mediaType === "application/json";
    },
    debugRedactionProven: (id) => {
      const entry = debugProofs.get(id);
      return entry !== undefined && entry.valid && entry.bytesValid !== false && (entry.kind !== "checkpoint-unavailable" || entry.protocolValid === true && entry.proof?.secrecy === debugSinks.get(sink)?.proof()?.secrecy) && debugProofValid(entry.proof, entry.kind);
    },
  };
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
 * run's report still names. The number is read, not claimed: two runs on one
 * output at once already share its report and empty each other's results, so
 * a run owns its output alone, and a rerun is no exception.
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

/**
 * Reads one hosted file through a no-follow descriptor and checks it still
 * names the same contained, single-link file before its bytes can reach a store.
 */
async function readHosted(root: string, relative: string, original?: ArtifactFileAnchor, strict = true): Promise<Buffer | undefined> {
  if (strict && !relativeArtifactPath(relative)) return undefined;
  try {
    const anchor = original ?? anchorArtifactFile(root, relative);
    if (anchor === undefined || !artifactAnchorCurrent(anchor)) return undefined;
    const file = await open(anchor.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!originalArtifactFile(info, anchor.info)) return undefined;
      const bytes = await file.readFile();
      if (!originalArtifactFile(await file.stat(), info) || !artifactAnchorCurrent(anchor)) return undefined;
      return bytes;
    } finally { await file.close(); }
  } catch {
    return undefined;
  }
}

/** Measures hosted evidence through one no-follow descriptor, with a final containment and identity check. */
async function measureHosted(root: string, relative: string, mediaKind?: DebugEvidenceKind, original?: ArtifactFileAnchor, strict = true): Promise<{ size: number; sha256: string; mediaType?: string } | undefined> {
  if (strict && !relativeArtifactPath(relative)) return undefined;
  try {
    const anchor = original ?? anchorArtifactFile(root, relative);
    if (anchor === undefined || !artifactAnchorCurrent(anchor)) return undefined;
    const file = await open(anchor.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!originalArtifactFile(info, anchor.info)) return undefined;
      const hash = createHash('sha256');
      let media: string | undefined;
      if (mediaKind === 'pixels') {
        const header = Buffer.alloc(8);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        media = verifiedDebugMedia(header.subarray(0, bytesRead), mediaKind);
        await pipeline(file.createReadStream({ autoClose: false, start: 0 }), hash);
      } else if (mediaKind !== undefined) {
        const bytes = await file.readFile();
        hash.update(bytes);
        media = verifiedDebugMedia(bytes, mediaKind);
      } else {
        await pipeline(file.createReadStream({ autoClose: false }), hash);
      }
      if (!originalArtifactFile(await file.stat(), info) || !artifactAnchorCurrent(anchor)) return undefined;
      return { size: info.size, sha256: hash.digest('hex'), ...(media === undefined ? {} : { mediaType: media }) };
    } finally { await file.close(); }
  } catch {
    return undefined;
  }
}

/**
 * The original private capture ticket selects a producer format. Bytes must
 * agree: PNG signature for engine screenshots, UTF-8 for semantic text, and
 * parseable JSON for the SDK JSON renderer. Extensions and public claims
 * cannot mint these facts. This does not establish pixel masking.
 */
function verifiedDebugMedia(bytes: Uint8Array, kind: DebugEvidenceKind | undefined, facts?: CheckpointUnavailableFacts): string | undefined {
  if (kind === "checkpoint-unavailable") return checkpointUnavailableBytesProven(bytes, facts) ? "application/json" : undefined;
  if (kind === 'pixels') return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : undefined;
  if (kind === undefined) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (kind === 'checkpoint-json') {
      JSON.parse(text);
      return 'application/json';
    }
    return 'text/plain';
  } catch { return undefined; }
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
