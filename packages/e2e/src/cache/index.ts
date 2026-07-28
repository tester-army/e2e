/**
 * Locate cache (`cache-1`, spec 10-determinism.md).
 *
 * The cache is an optimization and never authority. A hit cannot weaken query
 * strictness, origin policy, actionability, secret policy, budgets, or
 * reporting, and deleting the cache cannot change a correct test's meaning.
 */

import { join } from 'node:path';
import { FileCacheStore, disabledCacheStore, type CacheStore } from './store.ts';

export { MAX_CACHE_WIRE_BYTES, FileCacheStore, disabledCacheStore } from './store.ts';
export type { CacheStore, CacheReadResult } from './store.ts';
export { parseCacheEntry } from './entry.ts';
export type { CacheEntry, LocatePayload, ParsedEntry } from './entry.ts';
export {
  CACHE_METHODS,
  buildCacheKey,
  cacheKeyHash,
  cacheKeysEqual,
  cacheMethodForApi,
  instructionDigest,
  inputDigest,
  normalizeInstruction,
  projectIdentity,
} from './identity.ts';
export type { CacheKey, CacheMethod, CacheTargetIdentity } from './identity.ts';
export { screenFingerprint } from './fingerprint.ts';
export type { FingerprintInput } from './fingerprint.ts';
export {
  MAX_REGEXP_SOURCE_BYTES,
  toCacheLocator,
  toSemanticIdentity,
  validateRegexp,
} from './locator.ts';
export type { CacheLocator, CacheQuery, Projection, SemanticIdentity } from './locator.ts';

/** Directory holding one file per cache key, relative to the project root. */
export const CACHE_DIRECTORY = join('.e2e', 'cache');

/**
 * Builds the store for one run. Cache entries are committable project input,
 * so the directory lives beside the project rather than in a temporary space.
 */
export function createCacheStore(options: {
  readonly mode: 'off' | 'read-only' | 'read-write';
  readonly projectRoot: string;
  readonly maxBytes: number;
}): CacheStore {
  if (options.mode === 'off') return disabledCacheStore;
  return new FileCacheStore({
    directory: join(options.projectRoot, CACHE_DIRECTORY),
    maxBytes: options.maxBytes,
    writable: options.mode === 'read-write',
  });
}
