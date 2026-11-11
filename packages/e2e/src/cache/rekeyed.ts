import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from './store.ts';
import { cacheFileName, type CacheFormat } from './codec.ts';
import type { TraceKeyContext, TraceProvenance } from './trace.ts';

type StoredKey = { readonly keyHash: string; readonly format: CacheFormat };

export class StoredRecordings {
  private readonly stores: readonly FileCacheStore[];
  private listing: Promise<ReadonlyMap<string, readonly StoredKey[]>> | undefined;

  constructor(private readonly store: FileCacheStore, other: FileCacheStore = store) {
    this.stores = [...new Set([store, other])];
  }

  /** Finds a stale key or format, including an exact key whose legacy provenance is incomplete. */
  async underAnotherKey(keyHash: string, step: TraceProvenance): Promise<{ readonly keyHash: string; readonly fileName: string; readonly otherFormat: boolean; readonly keyedBy?: TraceKeyContext } | undefined> {
    const otherFormat = this.store.format === 'code' ? 'json' : 'code';
    const other = this.stores.find((candidate) => candidate.format === otherFormat);
    if (other !== undefined) {
      const exact = await other.read(keyHash).catch(() => undefined);
      if (exact !== undefined && exact.status !== 'miss') {
        return { keyHash, fileName: cacheFileName(keyHash, otherFormat), otherFormat: true };
      }
    }
    const key = stepKey(step);
    if (key === undefined) return undefined;
    let listing: ReadonlyMap<string, readonly StoredKey[]>;
    try { listing = await (this.listing ??= this.list()); } catch { return undefined; }
    for (const candidate of listing.get(key) ?? []) {
      if (candidate.keyHash === keyHash && candidate.format === this.store.format) continue;
      const read = await this.stores.find((store) => store.format === candidate.format)!.read(candidate.keyHash).catch(() => undefined);
      if (read?.status === 'hit') {
        const keyedBy = read.entry.payload.keyedBy;
        return { keyHash: candidate.keyHash, fileName: cacheFileName(candidate.keyHash, candidate.format), otherFormat: candidate.format !== this.store.format, ...(keyedBy === undefined ? {} : { keyedBy }) };
      }
    }
    return undefined;
  }

  /** Indexes both formats so switching representation cannot turn stale recordings into new steps. */
  private async list(): Promise<ReadonlyMap<string, readonly StoredKey[]>> {
    const steps = new Map<string, StoredKey[]>();
    for (const store of this.stores) {
      for (const keyHash of await store.keyHashes()) {
        const read = await store.read(keyHash);
        if (read.status !== 'hit' || read.entry.payload.truncated === true) continue;
        const key = read.entry.payload.recordedFor === undefined ? undefined : stepKey(read.entry.payload.recordedFor);
        if (key !== undefined) steps.set(key, [...(steps.get(key) ?? []), { keyHash, format: store.format }]);
      }
    }
    return steps;
  }
}

/** Builds a strict index over both local representations; custom stores own their lookup contract. */
export function storedRecordingsFor(cache: ResolvedCacheConfig): StoredRecordings | undefined {
  if (cache.strict === false || cache.mode === 'off' || cache.store !== undefined) return undefined;
  const options = { directory: cache.dir, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false };
  return new StoredRecordings(new FileCacheStore({ ...options, format: cache.format }), new FileCacheStore({ ...options, format: cache.format === 'code' ? 'json' : 'code' }));
}

/** The whole step as one map key, or undefined when provenance predates occurrence identity. */
function stepKey(step: TraceProvenance): string | undefined {
  const { testId, targetId, instructionDigest, paramsDigest, callIndex, agent } = step;
  if (paramsDigest === undefined || callIndex === undefined || agent === undefined) return undefined;
  return JSON.stringify([testId, targetId, instructionDigest, paramsDigest, callIndex, agent]);
}
