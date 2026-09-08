/**
 * Trace entry storage.
 *
 * One file per key under `.e2e/cache/`, named for the key digest. Reads fail
 * closed: an oversized or unreadable entry is a miss, never a repair. Writes go
 * through a temporary file and an atomic rename, so a crashed or concurrent
 * writer cannot leave a torn entry behind.
 *
 * There is no locking. Two writers only ever collide on a key when the same
 * step runs concurrently on the same path, and then they are writing the same
 * flow, so last-write-wins is the correct outcome rather than a hazard.
 *
 * The interface exists so a remote store — the cloud's shared cache — can
 * replace the filesystem without the harness noticing.
 */

import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { errorMessage } from '../internal/errors.ts';
import { buildTraceEntry, readTraceEntry, type ActionTrace, type TraceEntry } from './trace.ts';

/** Hard wire ceiling on one entry, on both the read and the write path. */
export const MAX_CACHE_WIRE_BYTES = 1_048_576;

const KEY_HASH = /^[a-f0-9]{64}$/u;

export type CacheReadResult =
  | { readonly status: 'hit'; readonly entry: TraceEntry; readonly bytes: number }
  | { readonly status: 'miss' }
  | { readonly status: 'invalid'; readonly reason: string; readonly bytes?: number };

export interface TraceCacheStore {
  readonly writable: boolean;
  read(keyHash: string): Promise<CacheReadResult>;
  /** Persists one trace, returning its size, or undefined when not written. */
  write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined>;
  /**
   * Evicts one entry, best-effort. Called when a replayed or just-recorded
   * flow is implicated in a failed attempt: the entry re-records on the next
   * pass instead of replaying a poisoned flow forever. Optional — a store
   * without eviction merely stays stale until the next confirmed write.
   */
  delete?(keyHash: string): Promise<void>;
}

export interface FileTraceCacheStoreOptions {
  readonly directory: string;
  /** Entry size cap for tests; production passes the wire ceiling, which clamps it. */
  readonly maxBytes: number;
  readonly writable: boolean;
}

export class FileTraceCacheStore implements TraceCacheStore {
  readonly writable: boolean;

  private readonly directory: string;
  private readonly maxBytes: number;

  constructor(options: FileTraceCacheStoreOptions) {
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

    let entry: TraceEntry | undefined;
    try {
      entry = readTraceEntry(JSON.parse(await readFile(path, 'utf8')));
    } catch (cause) {
      return { status: 'invalid', reason: `cache entry is unreadable: ${errorMessage(cause)}`, bytes };
    }
    if (entry === undefined) {
      return { status: 'invalid', reason: 'cache entry is not a replayable trace-1 entry', bytes };
    }
    return { status: 'hit', entry, bytes };
  }

  async write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined> {
    if (!this.writable) return undefined;
    const path = this.entryPath(keyHash);
    if (path === undefined) return undefined;

    const serialized = `${JSON.stringify(buildTraceEntry(payload), null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxBytes) return undefined;

    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(path, serialized, { mode: 0o600 });
    return { bytes };
  }

  async delete(keyHash: string): Promise<void> {
    if (!this.writable) return;
    const path = this.entryPath(keyHash);
    if (path === undefined) return;
    await unlink(path).catch(() => undefined);
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
