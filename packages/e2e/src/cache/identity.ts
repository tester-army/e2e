/**
 * Trace cache key identity (RFC0001 layer 3, cache-in decision).
 *
 * A key names the exact context a trace was recorded in. Every field that can
 * change replay behavior is part of the key, so a stale entry can only ever be
 * a miss rather than a wrong answer. Secret values never enter a key: a secret
 * contributes only its stable name and purpose, exactly as the executor sees
 * it in the projected params.
 *
 * Executor identity is deliberately absent (OQ10's conservative default):
 * entries are shared across roster members and carry their producer as
 * provenance on the entry, so a future ReplayPolicy can reject foreign traces
 * without a re-key.
 */

import { canonicalDigest, sha256Hex } from '../internal/ids.ts';
import type { JsonValue } from '../types.ts';
import { TRACE_SCHEMA_VERSION } from './trace.ts';

/**
 * Step kinds the trace cache admits. Only `act` today: an assert must not
 * change state, so its trace would be action-free, and judgments are made
 * fresh per run by normative rule (spec 10).
 */
export type TraceCacheKind = 'act';

export interface TraceCacheKey {
  readonly specVersion: '0.1';
  readonly cacheSchema: typeof TRACE_SCHEMA_VERSION;
  /** SHA-256 of the resolved `projectId`. */
  readonly project: string;
  readonly testId: string;
  readonly targetId: string;
  readonly platform: string;
  readonly backendName: string;
  readonly backendVersion: string;
  readonly backendSpiVersion: number;
  readonly kind: TraceCacheKind;
  /** Zero-based occurrence of this signature within the attempt. */
  readonly callIndex: number;
  readonly instructionDigest: string;
  readonly paramsDigest: string;
  readonly appIdentity: string;
  readonly policyVersion: string;
}

/** Identity of the target/backend/app a trace was recorded against. */
export interface CacheTargetIdentity {
  readonly targetId: string;
  readonly platform: string;
  readonly backendName: string;
  readonly backendVersion: string;
  readonly spiVersion: number;
  readonly appIdentity: string;
}

/**
 * Reduces a backend version to the part that can change how a semantic node
 * resolves: `1.61.1` becomes `1.61`. Keying on the exact version cold-started
 * every entry on a patch release for no benefit; a minor might change matching,
 * so that part is kept. A version that is not `major.minor[.patch]` is used
 * unchanged rather than guessed at.
 */
export function backendCompatibilityVersion(version: string): string {
  const match = /^(\d+)\.(\d+)(?:[.\-+].*)?$/u.exec(version);
  return match === null ? version : `${match[1]!}.${match[2]!}`;
}

/**
 * Normalizes one instruction before digesting it: CRLF/CR become LF, the text
 * is NFC-normalized, and leading/trailing Unicode whitespace is trimmed.
 * Interior whitespace is preserved, because it can be semantically meaningful.
 */
export function normalizeInstruction(instruction: string): string {
  return instruction.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
}

/** SHA-256 of the normalized instruction. */
export function instructionDigest(instruction: string): string {
  return sha256Hex(normalizeInstruction(instruction));
}

/**
 * SHA-256/JCS of the projected (secret-free) call parameters. A missing params
 * object digests as the empty object, so `act(x)` and `act(x, {})` share one
 * entry.
 */
export function paramsDigest(params: Readonly<Record<string, JsonValue>> | undefined): string {
  return canonicalDigest(params ?? {});
}

/** SHA-256 of the resolved project identity. */
export function projectIdentity(projectId: string): string {
  return sha256Hex(projectId);
}

/**
 * What a step asks for, independent of where it sits in the test: the kind
 * plus the digests of its instruction and projected parameters.
 *
 * Two steps sharing a signature are the same request, so this is the scope the
 * occurrence index counts within. Scoping it any wider — counting every agent
 * step in the test — would make an unrelated step appearing or disappearing
 * renumber every entry after it, which is exactly what a conditional flow like
 * an optional cookie dialog does on a real site.
 */
export interface TraceCallSignature {
  readonly kind: TraceCacheKind;
  readonly instructionDigest: string;
  readonly paramsDigest: string;
}

/** Builds one signature by digesting the instruction and projected parameters. */
export function traceCallSignature(
  kind: TraceCacheKind,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
): TraceCallSignature {
  return {
    kind,
    instructionDigest: instructionDigest(instruction),
    paramsDigest: paramsDigest(params),
  };
}

/**
 * Map key for one signature. Both digests are hex, so a colon cannot appear
 * inside either and the join is unambiguous.
 */
function traceCallSignatureKey(signature: TraceCallSignature): string {
  return `${signature.kind}:${signature.instructionDigest}:${signature.paramsDigest}`;
}

/**
 * Counts occurrences of each call signature within one attempt, returning the
 * zero-based index of each step among its own repeats. Per signature rather
 * than per attempt on purpose: only a genuine repeat of the same request
 * advances the number.
 */
export function createCallIndexer(): (signature: TraceCallSignature) => number {
  const seen = new Map<string, number>();
  return (signature) => {
    const mapKey = traceCallSignatureKey(signature);
    const count = seen.get(mapKey) ?? 0;
    seen.set(mapKey, count + 1);
    return count;
  };
}

/**
 * Assembles one key. Field order is irrelevant to the digest, since JCS sorts
 * keys, but the explicit shape keeps every required field accounted for.
 */
export function buildTraceCacheKey(parts: {
  readonly project: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly signature: TraceCallSignature;
  readonly callIndex: number;
  readonly policyVersion: string;
}): TraceCacheKey {
  return {
    specVersion: '0.1',
    cacheSchema: TRACE_SCHEMA_VERSION,
    project: parts.project,
    testId: parts.testId,
    targetId: parts.target.targetId,
    platform: parts.target.platform,
    backendName: parts.target.backendName,
    backendVersion: backendCompatibilityVersion(parts.target.backendVersion),
    backendSpiVersion: parts.target.spiVersion,
    kind: parts.signature.kind,
    callIndex: parts.callIndex,
    instructionDigest: parts.signature.instructionDigest,
    paramsDigest: parts.signature.paramsDigest,
    appIdentity: parts.target.appIdentity,
    policyVersion: parts.policyVersion,
  };
}

/** SHA-256/JCS of one key, used as both the entry digest and its file name. */
export function traceCacheKeyHash(key: TraceCacheKey): string {
  return canonicalDigest(key);
}
