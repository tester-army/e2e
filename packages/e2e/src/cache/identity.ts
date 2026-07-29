/**
 * Cache key identity (spec 10-determinism.md "Cache identity").
 *
 * A key names the exact context an entry was recorded in. Every field that can
 * change replay behavior is part of the key, so a stale entry can only ever be
 * a miss rather than a wrong answer. Secret values never enter a key: a secret
 * contributes only its stable name and purpose.
 */

import { canonicalDigest, sha256Hex } from '../internal/ids.ts';

/**
 * Public methods that may be cached, per `cache-1` `key.method`. Located
 * actions outside this set are never cached even though they use the model.
 */
export const CACHE_METHODS = [
  'act',
  'tap',
  'click',
  'type',
  'scroll',
  'scrollTo',
  'longPress',
] as const;

export type CacheMethod = (typeof CACHE_METHODS)[number];

const CACHE_METHOD_SET: ReadonlySet<string> = new Set(CACHE_METHODS);

/** True when a value names a method `cache-1` admits. */
function isCacheMethod(value: unknown): value is CacheMethod {
  return typeof value === 'string' && CACHE_METHOD_SET.has(value);
}

export interface CacheKey {
  readonly specVersion: '0.1';
  readonly cacheSchema: 'cache-1';
  /** SHA-256 of the resolved `projectId`. */
  readonly project: string;
  readonly testId: string;
  readonly targetId: string;
  readonly platform: string;
  readonly driverId: string;
  readonly driverVersion: string;
  readonly driverSpiVersion: 1;
  readonly method: CacheMethod;
  /** Zero-based index of this agent call in the executed test path. */
  readonly callIndex: number;
  readonly instructionDigest: string;
  readonly inputDigest: string;
  readonly appIdentity: string;
  readonly screenFingerprint: string;
  readonly policyVersion: string;
}

/**
 * Reduces a driver version to the part that can change how a semantic query
 * resolves: `1.61.1` becomes `1.61`.
 *
 * Keying on the exact version meant a driver patch release cold-started every
 * entry, which is a large cost for no benefit — a patch does not change what
 * `getByRole` matches. A minor release might, so that part is kept. A version
 * that is not `major.minor[.patch]` is used unchanged rather than guessed at.
 */
export function driverCompatibilityVersion(version: string): string {
  const match = /^(\d+)\.(\d+)(?:[.\-+].*)?$/u.exec(version);
  return match === null ? version : `${match[1]!}.${match[2]!}`;
}

/** Identity of the target/driver/app an entry was recorded against. */
export interface CacheTargetIdentity {
  readonly targetId: string;
  readonly platform: string;
  readonly driverId: string;
  readonly driverVersion: string;
  readonly spiVersion: number;
  readonly appIdentity: string;
}

/**
 * Maps a public API name onto its `cache-1` method, or undefined when the
 * method is not cacheable.
 */
export function cacheMethodForApi(api: string): CacheMethod | undefined {
  const method = api.startsWith('agent.') ? api.slice('agent.'.length) : api;
  return isCacheMethod(method) ? method : undefined;
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
 * SHA-256/JCS of the non-secret parameters a call was made with. Callers pass
 * secret parameters as their stable name and purpose, never their value.
 */
export function inputDigest(input: Readonly<Record<string, unknown>>): string {
  return canonicalDigest(input);
}

/** SHA-256 of the resolved project identity. */
export function projectIdentity(projectId: string): string {
  return sha256Hex(projectId);
}

/**
 * What a call asks for, independent of where it sits in the test: the method
 * plus the digests of its instruction and non-secret parameters.
 *
 * Two calls sharing a signature are the same request, so this is the scope the
 * occurrence index counts within. Scoping it any wider — counting every agent
 * call in the test — would make an unrelated call appearing or disappearing
 * renumber every entry after it, which is exactly what a conditional step like
 * an optional cookie dialog does on a real site.
 */
export interface CacheCallSignature {
  readonly method: CacheMethod;
  readonly instructionDigest: string;
  readonly inputDigest: string;
}

/** Builds one signature by digesting the instruction and parameters. */
export function cacheCallSignature(
  method: CacheMethod,
  instruction: string,
  input: Readonly<Record<string, unknown>>,
): CacheCallSignature {
  return {
    method,
    instructionDigest: instructionDigest(instruction),
    inputDigest: inputDigest(input),
  };
}

/**
 * Map key for one signature. Both digests are hex, so a colon cannot appear
 * inside either and the join is unambiguous.
 */
function cacheCallSignatureKey(signature: CacheCallSignature): string {
  return `${signature.method}:${signature.instructionDigest}:${signature.inputDigest}`;
}

/**
 * Counts occurrences of each call signature within one attempt, returning the
 * zero-based index of each call among its own repeats.
 *
 * The counter is per signature rather than per attempt on purpose. A single
 * running total would mean any conditional step — an optional cookie dialog, a
 * branch that only fires on some sessions — renumbers every entry recorded
 * after it, so a suite against a real site could never warm up. Scoped this
 * way, only a genuine repeat of the same request advances the number.
 */
export function createCallIndexer(): (signature: CacheCallSignature) => number {
  const seen = new Map<string, number>();
  return (signature) => {
    const mapKey = cacheCallSignatureKey(signature);
    const count = seen.get(mapKey) ?? 0;
    seen.set(mapKey, count + 1);
    return count;
  };
}

/**
 * Assembles one key. Field order is irrelevant to the digest, since JCS sorts
 * keys, but the explicit shape keeps every required field accounted for.
 */
export function buildCacheKey(parts: {
  readonly project: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly signature: CacheCallSignature;
  /** Zero-based occurrence of this signature within the attempt. */
  readonly callIndex: number;
  readonly screenFingerprint: string;
  readonly policyVersion: string;
}): CacheKey {
  return {
    specVersion: '0.1',
    cacheSchema: 'cache-1',
    project: parts.project,
    testId: parts.testId,
    targetId: parts.target.targetId,
    platform: parts.target.platform,
    driverId: parts.target.driverId,
    driverVersion: driverCompatibilityVersion(parts.target.driverVersion),
    driverSpiVersion: 1,
    method: parts.signature.method,
    callIndex: parts.callIndex,
    instructionDigest: parts.signature.instructionDigest,
    inputDigest: parts.signature.inputDigest,
    appIdentity: parts.target.appIdentity,
    screenFingerprint: parts.screenFingerprint,
    policyVersion: parts.policyVersion,
  };
}

/** SHA-256/JCS of one key, used as both the entry digest and its file name. */
export function cacheKeyHash(key: CacheKey): string {
  return canonicalDigest(key);
}
