/**
 * `cache-1` entry reading and writing (spec 13-reporting.md "cache-1").
 *
 * An entry is deliberately small: a schema version, when it was written, and
 * the locator to replay with the identity it had. It does not repeat its own
 * key. The file name is the key digest and the runner only ever opens the digest
 * of the key it just computed, so a file being there already means it is for
 * this call.
 *
 * The one thing worth validating is the locator's shape, because that is what
 * gets handed to the locator engine. Everything else is either informational or
 * cannot affect what runs, so it is read as-is and a malformed entry is a plain
 * miss.
 */

import { asCacheLocator, asSemanticIdentity, type CacheLocator, type SemanticIdentity } from './locator.ts';

export interface LocatePayload {
  readonly locator: CacheLocator;
  readonly expected: SemanticIdentity;
}

export interface CacheEntry {
  readonly schemaVersion: 'cache-1';
  readonly createdAt: string;
  readonly payload: LocatePayload;
}

/**
 * Reads one document as a `cache-1` locate entry, or returns undefined when it
 * is not one this runner can replay. `path` entries are a valid `cache-1` shape
 * with no producer or consumer here yet, and are simply not locate entries.
 */
export function readCacheEntry(document: unknown): CacheEntry | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return undefined;
  }
  const raw = document as Record<string, unknown>;
  if (raw['schemaVersion'] !== 'cache-1') return undefined;
  if (raw['kind'] !== undefined && raw['kind'] !== 'locate') return undefined;

  const payload = raw['payload'];
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { locator, expected } = payload as Record<string, unknown>;

  const validated = asCacheLocator(locator);
  if (validated === undefined) return undefined;
  const identity = asSemanticIdentity(expected);
  if (identity === undefined) return undefined;

  return {
    schemaVersion: 'cache-1',
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    payload: { locator: validated, expected: identity },
  };
}
