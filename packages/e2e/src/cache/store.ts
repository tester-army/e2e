/**
 * Cache entry storage (spec 10-determinism.md "Storage and concurrency").
 *
 * One file per key under `.e2e/cache/`, named for the key digest. Reads fail
 * closed: an oversized or unreadable entry is a miss, never a repair. Writes go
 * through a temporary file and an atomic rename, so a crashed or concurrent
 * writer cannot leave a torn entry behind.
 *
 * There is no locking. Two writers only ever collide on a key when the same
 * call runs concurrently on the same route, and then they are writing the same
 * locator, so last-write-wins is the correct outcome rather than a hazard.
 *
 * The interface exists so a remote store can replace the filesystem without the
 * agent noticing.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { readCacheEntry, type CacheEntry, type LocatePayload } from './entry.ts';

/** Hard wire ceiling from 13-reporting.md; config may lower it, never raise it. */
export const MAX_CACHE_WIRE_BYTES = 1_048_576;

const KEY_HASH = /^[a-f0-9]{64}$/u;

export type CacheReadResult =
  | { readonly status: 'hit'; readonly entry: CacheEntry; readonly bytes: number }
  | { readonly status: 'miss' }
  | { readonly status: 'invalid'; readonly reason: string; readonly bytes?: number };

export interface CacheStore {
  /**
   * Why this store can neither hit nor be written to, or undefined when it is
   * usable. Callers check this before building a key, so a disabled cache costs
   * nothing rather than merely returning nothing. The reason and the disabled
   * state are one field so they cannot disagree; `--debug` prints it verbatim.
   */
  readonly unusable?: string;
  readonly writable: boolean;
  read(keyHash: string): Promise<CacheReadResult>;
  /** Persists one entry, returning its size, or undefined when not written. */
  write(keyHash: string, payload: LocatePayload): Promise<{ bytes: number } | undefined>;
}

/**
 * A store that never hits and never writes. This is the single representation of
 * "no cache": mode `off`, a retry attempt, and a caller with no cache at all all
 * resolve to one of these.
 */
export function disabledCacheStore(reason: string): CacheStore {
  return {
    unusable: reason,
    writable: false,
    read: async () => ({ status: 'miss' }),
    write: async () => undefined,
  };
}

export interface FileCacheStoreOptions {
  readonly directory: string;
  /** Resolved `limits.maxCacheBytes`, capped by the wire ceiling. */
  readonly maxBytes: number;
  readonly writable: boolean;
}

export class FileCacheStore implements CacheStore {
  readonly writable: boolean;

  private readonly directory: string;
  private readonly maxBytes: number;

  constructor(options: FileCacheStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = Math.min(options.maxBytes, MAX_CACHE_WIRE_BYTES);
    this.writable = options.writable;
  }

  async read(keyHash: string): Promise<CacheReadResult> {
    const path = this.entryPath(keyHash);
    if (path === undefined) return { status: 'invalid', reason: 'key hash is not a SHA-256 digest' };

    let bytes: number;
    try {
      bytes = (await stat(path)).size;
    } catch {
      return { status: 'miss' };
    }
    // Checked before the read so an oversized file is never pulled into memory.
    if (bytes > this.maxBytes) {
      return {
        status: 'invalid',
        reason: `cache entry is ${bytes} bytes, over the ${this.maxBytes}-byte limit`,
        bytes,
      };
    }

    let entry: CacheEntry | undefined;
    try {
      entry = readCacheEntry(JSON.parse(await readFile(path, 'utf8')));
    } catch (cause) {
      return { status: 'invalid', reason: `cache entry is unreadable: ${errorMessage(cause)}`, bytes };
    }
    if (entry === undefined) {
      return { status: 'invalid', reason: 'cache entry is not a replayable cache-1 locate entry', bytes };
    }
    return { status: 'hit', entry, bytes };
  }

  async write(keyHash: string, payload: LocatePayload): Promise<{ bytes: number } | undefined> {
    if (!this.writable) return undefined;
    const path = this.entryPath(keyHash);
    if (path === undefined) return undefined;

    const entry: CacheEntry = { schemaVersion: 'cache-1', createdAt: timestamp(), payload };
    const serialized = `${JSON.stringify({ ...entry, kind: 'locate' }, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxBytes) return undefined;

    await mkdir(this.directory, { recursive: true });
    // Random rather than pid+clock: two writers racing on one key in the same
    // millisecond would otherwise pick the same temporary name, and the first
    // rename would pull the file out from under the second.
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
    return { bytes };
  }

  /**
   * Resolves one entry path. The key hash is the only caller-supplied path
   * component and must be a bare digest, so traversal is impossible by
   * construction rather than by canonicalization after the fact.
   */
  private entryPath(keyHash: string): string | undefined {
    return KEY_HASH.test(keyHash) ? join(this.directory, `${keyHash}.json`) : undefined;
  }
}
