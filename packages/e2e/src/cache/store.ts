/**
 * Cache entry storage (spec 10-determinism.md "Storage and concurrency").
 *
 * One file per key under `.e2e/cache/`. Reads fail closed: an entry that is
 * oversized, malformed, or whose digest does not match its content is ignored
 * and reported, never repaired and never executed. Writes take an exclusive
 * per-key lock, read the current generation under it, and atomically rename a
 * fsynced temporary file into place, so a crashed or concurrent writer cannot
 * leave a torn entry behind.
 *
 * The interface exists so a remote store can replace the filesystem without
 * the agent noticing. Every entry authorizes itself through its own key digest
 * and identity fields, so a remote store needs no additional trust.
 */

import { open, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../internal/time.ts';
import { timestamp } from '../internal/ids.ts';
import { parseCacheEntry, type CacheEntry, type LocatePayload } from './entry.ts';
import { cacheKeyHash, type CacheKey } from './identity.ts';

/** Hard wire ceiling from 13-reporting.md; config may lower it, never raise it. */
export const MAX_CACHE_WIRE_BYTES = 1_048_576;

/** How long a lock file may sit untouched before a later writer steals it. */
const LOCK_STALE_MS = 10_000;

const LOCK_RETRY_MS = 25;

/** Age at which a leftover temporary file is assumed abandoned. */
const TEMPORARY_STALE_MS = 60_000;

const KEY_HASH = /^[a-f0-9]{64}$/u;

export type CacheReadResult =
  | { readonly status: 'hit'; readonly entry: CacheEntry; readonly bytes: number }
  | { readonly status: 'miss' }
  | { readonly status: 'invalid'; readonly reason: string; readonly bytes?: number };

export interface CacheStore {
  /** True when this store may be written to. */
  readonly writable: boolean;
  read(keyHash: string): Promise<CacheReadResult>;
  /** Persists one entry, returning its size, or undefined when not writable. */
  write(key: CacheKey, payload: LocatePayload): Promise<{ bytes: number } | undefined>;
}

/** A store that never hits and never writes, used for cache mode `off`. */
export const disabledCacheStore: CacheStore = {
  writable: false,
  read: async () => ({ status: 'miss' }),
  write: async () => undefined,
};

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
  private swept = false;

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
      const stats = await stat(path);
      if (!stats.isFile()) return { status: 'invalid', reason: 'cache entry is not a regular file' };
      bytes = stats.size;
    } catch {
      return { status: 'miss' };
    }
    // The size is checked before the read so an oversized or hostile file
    // cannot be pulled into memory in the first place.
    if (bytes > this.maxBytes) {
      return {
        status: 'invalid',
        reason: `cache entry is ${bytes} bytes, over the ${this.maxBytes}-byte limit`,
        bytes,
      };
    }

    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, 'utf8'));
    } catch (cause) {
      return {
        status: 'invalid',
        reason: `cache entry is not valid JSON: ${message(cause)}`,
        bytes,
      };
    }

    const parsed = parseCacheEntry(document);
    if (!parsed.ok) return { status: 'invalid', reason: parsed.reason, bytes };

    const recomputed = cacheKeyHash(parsed.value.key);
    if (recomputed !== parsed.value.keyHash) {
      return { status: 'invalid', reason: 'keyHash does not match the entry key', bytes };
    }
    // A correct digest for the wrong file name means the entry was moved or
    // renamed; treating it as authoritative would let one key answer another.
    if (recomputed !== keyHash) {
      return { status: 'invalid', reason: 'cache entry is stored under a foreign key', bytes };
    }
    return { status: 'hit', entry: parsed.value, bytes };
  }

  async write(key: CacheKey, payload: LocatePayload): Promise<{ bytes: number } | undefined> {
    if (!this.writable) return undefined;
    const keyHash = cacheKeyHash(key);
    const path = this.entryPath(keyHash);
    if (path === undefined) return undefined;

    await mkdir(this.directory, { recursive: true });
    await this.sweepTemporaries();
    return this.withLock(keyHash, async () => {
      const entry: CacheEntry = {
        schemaVersion: 'cache-1',
        kind: 'locate',
        key,
        keyHash,
        generation: (await this.currentGeneration(path)) + 1,
        createdAt: timestamp(),
        payload,
      };
      const serialized = `${JSON.stringify(entry, null, 2)}\n`;
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > this.maxBytes) return undefined;

      const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
      try {
        const handle = await open(temporary, 'w', 0o600);
        try {
          await handle.writeFile(serialized, 'utf8');
          await handle.sync().catch(() => undefined);
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      } catch (cause) {
        await unlink(temporary).catch(() => undefined);
        throw cause;
      }
      return { bytes };
    });
  }

  /**
   * Removes temporary files a killed writer left behind. They are already
   * ignored by readers, which only ever open `<digest>.json`, so this is
   * housekeeping and its failure is never fatal.
   */
  private async sweepTemporaries(): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    try {
      const names = await readdir(this.directory);
      const cutoff = Date.now() - TEMPORARY_STALE_MS;
      await Promise.all(
        names
          .filter((name) => name.endsWith('.tmp'))
          .map(async (name) => {
            const path = join(this.directory, name);
            const stats = await stat(path).catch(() => undefined);
            if (stats !== undefined && stats.mtimeMs < cutoff) {
              await unlink(path).catch(() => undefined);
            }
          }),
      );
    } catch {
      // A missing or unreadable directory means there is nothing to sweep.
    }
  }

  /**
   * Reads the generation of the entry being replaced. A missing or unreadable
   * entry starts the sequence over at 1 rather than failing the write: the
   * generation is bookkeeping for concurrent writers, not authority.
   */
  private async currentGeneration(path: string): Promise<number> {
    try {
      const parsed = parseCacheEntry(JSON.parse(await readFile(path, 'utf8')));
      return parsed.ok ? parsed.value.generation : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Holds an exclusive lock for one key. `wx` makes creation the atomic test.
   * A lock left behind by a killed process is stolen once it goes stale, so a
   * crash cannot wedge a key permanently.
   */
  private async withLock<Value>(keyHash: string, body: () => Promise<Value>): Promise<Value> {
    const lockPath = join(this.directory, `${keyHash}.lock`);
    const deadline = Date.now() + LOCK_STALE_MS * 2;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.close();
        break;
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
        if (await this.stealStaleLock(lockPath)) continue;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the cache lock on ${keyHash}`, { cause });
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await body();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async stealStaleLock(lockPath: string): Promise<boolean> {
    try {
      const stats = await stat(lockPath);
      if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false;
      await unlink(lockPath);
      return true;
    } catch {
      // The lock disappeared on its own, which is the outcome we wanted.
      return true;
    }
  }

  /**
   * Resolves one entry path. The key hash is the only caller-supplied path
   * component, and it must be a bare digest, so traversal is impossible by
   * construction rather than by canonicalization after the fact.
   */
  private entryPath(keyHash: string): string | undefined {
    return KEY_HASH.test(keyHash) ? join(this.directory, `${keyHash}.json`) : undefined;
  }
}

function isAlreadyExists(cause: unknown): boolean {
  return (cause as { code?: string } | null)?.code === 'EEXIST';
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
