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
 * Only the file store can be listed. Each lookup reads the requested test's
 * container, so unrelated tests never become stale-key candidates.
 */

import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from './store.ts';
import type { TraceKeyContext, TraceProvenance } from './trace.ts';

export class StoredRecordings {
  constructor(private readonly directory: string) {}

  /** Finds stale keys only inside the requested test's file, never in unrelated tests. */
  async underAnotherKey(keyHash: string, step: TraceProvenance, fileTestId = step.testId): Promise<{ readonly keyHash: string; readonly keyedBy?: TraceKeyContext } | undefined> {
    const key = stepKey(step);
    if (key === undefined) return undefined;
    const store = new FileCacheStore({ directory: this.directory, testId: fileTestId, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
    const recording = await store.recording().catch(() => undefined);
    for (const candidate of recording?.recording.steps ?? []) {
      const trace = candidate.trace;
      if (candidate.key === keyHash || trace.truncated || trace.recordedFor === undefined || stepKey(trace.recordedFor) !== key) continue;
      return { keyHash: candidate.key, ...(trace.keyedBy === undefined ? {} : { keyedBy: trace.keyedBy }) };
    }
    return undefined;
  }
}

/** Custom stores own their own listing contract; file lookups are scoped to one test. */
export function storedRecordingsFor(cache: ResolvedCacheConfig): StoredRecordings | undefined {
  if (cache.strict === false || cache.mode === 'off' || cache.store !== undefined) return undefined;
  return new StoredRecordings(cache.dir);
}

/** The whole step as one map key, or undefined when the provenance does not record all of it. */
function stepKey(step: TraceProvenance): string | undefined {
  const { testId, targetId, instructionDigest, paramsDigest, callIndex, agent } = step;
  if (paramsDigest === undefined || callIndex === undefined || agent === undefined) return undefined;
  return JSON.stringify([testId, targetId, instructionDigest, paramsDigest, callIndex, agent]);
}
