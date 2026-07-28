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
  return CACHE_METHOD_SET.has(method) ? (method as CacheMethod) : undefined;
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
 * Assembles one key. Field order is irrelevant to the digest, since JCS sorts
 * keys, but the explicit shape keeps every required field accounted for.
 */
export function buildCacheKey(parts: {
  readonly project: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly method: CacheMethod;
  readonly callIndex: number;
  readonly instruction: string;
  readonly input: Readonly<Record<string, unknown>>;
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
    driverVersion: parts.target.driverVersion,
    driverSpiVersion: 1,
    method: parts.method,
    callIndex: parts.callIndex,
    instructionDigest: instructionDigest(parts.instruction),
    inputDigest: inputDigest(parts.input),
    appIdentity: parts.target.appIdentity,
    screenFingerprint: parts.screenFingerprint,
    policyVersion: parts.policyVersion,
  };
}

/** SHA-256/JCS of one key, used as both the entry digest and its file name. */
export function cacheKeyHash(key: CacheKey): string {
  return canonicalDigest(key);
}

/**
 * True when two keys are identical in every field. Replay compares the whole
 * key rather than trusting the file name, so a renamed or relocated entry can
 * never authorize itself.
 */
export function cacheKeysEqual(a: CacheKey, b: CacheKey): boolean {
  return canonicalDigest(a) === canonicalDigest(b);
}
