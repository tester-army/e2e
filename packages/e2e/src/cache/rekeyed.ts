/**
 * Recordings stored under a key the runner no longer derives.
 *
 * A key names everything that can change replay (`identity.ts`), so a new
 * replay policy, an engine minor, or an agent's context changing turns every
 * entry recorded before into a lookup miss, the same `no-entry` as a step
 * that was never recorded. `cache.strict` lets a never-recorded step run
 * live, so without this it would let a whole committed cache go quietly
 * unused. The entries say which step they were recorded for
 * (`TraceProvenance`), and a step whose own key misses while the store holds
 * a recording made for it is stale, not new.
 *
 * Only the file store can be listed. The listing is read once per run, on
 * the first strict miss that asks, and kept: every entry written since has a
 * key the run derives, so it is a hit rather than a candidate here.
 */

import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from './store.ts';
import type { TraceProvenance } from './trace.ts';

/** One listed entry: its key hash and the step it was recorded for. */
interface ListedRecording {
  readonly keyHash: string;
  readonly recordedFor: TraceProvenance;
}

export class StoredRecordings {
  private readonly store: FileCacheStore;
  private listing: Promise<ReadonlyMap<string, readonly ListedRecording[]>> | undefined;

  constructor(store: FileCacheStore) {
    this.store = store;
  }

  /**
   * The key hash of an entry recorded for `step` under another key, or
   * undefined when there is none or the store cannot be listed. `step` is in
   * the form an entry stores it (`recordedProvenance`). A field an older
   * entry did not record matches any value, so an entry from before the
   * occurrence fields were recorded is found by test, target, and
   * instruction. A truncated entry never replays under any key, so it is
   * never the reason a step is stale.
   */
  async underAnotherKey(keyHash: string, step: TraceProvenance): Promise<string | undefined> {
    let listing: ReadonlyMap<string, readonly ListedRecording[]>;
    try {
      this.listing ??= this.list();
      listing = await this.listing;
    } catch {
      return undefined;
    }
    for (const candidate of listing.get(stepGroup(step)) ?? []) {
      if (candidate.keyHash === keyHash || !sameStep(candidate.recordedFor, step)) continue;
      // Listed once per run: an entry evicted since is no evidence.
      const read = await this.store.read(candidate.keyHash).catch(() => undefined);
      if (read?.status === 'hit') return candidate.keyHash;
    }
    return undefined;
  }

  /** Every replayable entry that records its step, grouped by `stepGroup`. */
  private async list(): Promise<ReadonlyMap<string, readonly ListedRecording[]>> {
    const groups = new Map<string, ListedRecording[]>();
    for (const keyHash of await this.store.keyHashes()) {
      const read = await this.store.read(keyHash);
      if (read.status !== 'hit') continue;
      const { recordedFor, truncated } = read.entry.payload;
      if (recordedFor === undefined || truncated === true) continue;
      const group = stepGroup(recordedFor);
      groups.set(group, [...(groups.get(group) ?? []), { keyHash, recordedFor }]);
    }
    return groups;
  }
}

/**
 * The listing `cache.strict` checks a run's misses against: one per run,
 * shared by its attempts, for the file store only. Undefined when strict is
 * off, the cache is off, or a custom `cache.store` replaced the file store,
 * which `CacheStore` gives no way to list.
 */
export function storedRecordingsFor(cache: ResolvedCacheConfig): StoredRecordings | undefined {
  if (cache.strict === false || cache.mode === 'off' || cache.store !== undefined) return undefined;
  return new StoredRecordings(new FileCacheStore({ directory: cache.dir, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false }));
}

/** The fields every recorded provenance carries, as one map key. */
function stepGroup(step: TraceProvenance): string {
  return JSON.stringify([step.testId, step.targetId, step.instructionDigest]);
}

/** Whether `recorded` names `step`, a field the entry did not record matching anything. */
function sameStep(recorded: TraceProvenance, step: TraceProvenance): boolean {
  return (
    (recorded.paramsDigest === undefined || recorded.paramsDigest === step.paramsDigest) &&
    (recorded.callIndex === undefined || recorded.callIndex === step.callIndex) &&
    (recorded.agent === undefined || recorded.agent === step.agent)
  );
}
