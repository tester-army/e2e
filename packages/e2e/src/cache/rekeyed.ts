/**
 * Recordings stored under a key the runner no longer derives.
 *
 * A key names everything that can change replay (`identity.ts`), so a new
 * replay policy, a new key field, or an agent's context changing turns every
 * entry recorded before into a lookup miss, the same `no-entry` as a step
 * that was never recorded. `cache.strict` lets a never-recorded step run
 * live, so without this it would let a whole committed cache go quietly
 * unused. The entries say which step they were recorded for
 * (`TraceProvenance`), and a step whose own key misses while the store holds
 * a recording made for exactly that step is stale, not new.
 *
 * Only the file store can be listed. The listing is read once per worker
 * and target, on the first strict miss that asks, and kept: every entry
 * written since has a key the run derives, so it is a hit rather than a
 * candidate here.
 */

import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from './store.ts';
import type { TraceKeyContext, TraceProvenance } from './trace.ts';

export class StoredRecordings {
  private readonly store: FileCacheStore;
  /** Key hashes by `stepKey` of the step each entry was recorded for. */
  private listing: Promise<ReadonlyMap<string, readonly string[]>> | undefined;

  constructor(store: FileCacheStore) {
    this.store = store;
  }

  /**
   * The key hash of an entry recorded for `step` under a key other than
   * `keyHash`, with the key context it recorded, or undefined when there is none or the store cannot be
   * listed. `step` is in the form an entry stores it (`recordedProvenance`).
   * Only an entry that records the whole step counts: one written before the
   * params, occurrence, and agent were recorded could belong to another call
   * of the same instruction, and a read-write run that replays it completes
   * it (`flushStagedTraces`). A truncated entry never replays under any key,
   * so it is never the reason a step is stale.
   */
  async underAnotherKey(keyHash: string, step: TraceProvenance): Promise<{ readonly keyHash: string; readonly keyedBy?: TraceKeyContext } | undefined> {
    const key = stepKey(step);
    if (key === undefined) return undefined;
    let listing: ReadonlyMap<string, readonly string[]>;
    try {
      this.listing ??= this.list();
      listing = await this.listing;
    } catch {
      return undefined;
    }
    for (const candidate of listing.get(key) ?? []) {
      if (candidate === keyHash) continue;
      // Listed once: an entry evicted since is no evidence.
      const read = await this.store.read(candidate).catch(() => undefined);
      if (read?.status === 'hit') {
        const keyedBy = read.entry.payload.keyedBy;
        return { keyHash: candidate, ...(keyedBy === undefined ? {} : { keyedBy }) };
      }
    }
    return undefined;
  }

  /** Every replayable entry that records its whole step, by `stepKey`. */
  private async list(): Promise<ReadonlyMap<string, readonly string[]>> {
    const steps = new Map<string, string[]>();
    for (const keyHash of await this.store.keyHashes()) {
      const read = await this.store.read(keyHash);
      if (read.status !== 'hit' || read.entry.payload.truncated === true) continue;
      const key = read.entry.payload.recordedFor === undefined ? undefined : stepKey(read.entry.payload.recordedFor);
      if (key !== undefined) steps.set(key, [...(steps.get(key) ?? []), keyHash]);
    }
    return steps;
  }
}

/**
 * The listing `cache.strict` checks a run's misses against, for the file
 * store only. Undefined when strict is off, the cache is off, or a custom
 * `cache.store` replaced the file store, which `CacheStore` gives no way to
 * list.
 */
export function storedRecordingsFor(cache: ResolvedCacheConfig): StoredRecordings | undefined {
  if (cache.strict === false || cache.mode === 'off' || cache.store !== undefined) return undefined;
  return new StoredRecordings(new FileCacheStore({ directory: cache.dir, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false }));
}

/** The whole step as one map key, or undefined when the provenance does not record all of it. */
function stepKey(step: TraceProvenance): string | undefined {
  const { testId, targetId, instructionDigest, paramsDigest, callIndex, agent } = step;
  if (paramsDigest === undefined || callIndex === undefined || agent === undefined) return undefined;
  return JSON.stringify([testId, targetId, instructionDigest, paramsDigest, callIndex, agent]);
}
