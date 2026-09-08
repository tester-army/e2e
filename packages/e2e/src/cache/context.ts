/**
 * Per-attempt cache context.
 *
 * Built by the runner once per attempt and handed to the agent tier: the
 * resolved store, key derivation over the attempt's fixed identity, and the
 * staging ground for trace writes. Replay is eligible only on a first attempt
 * — a retry exists because something already went wrong, so it runs fresh and
 * re-records.
 */

import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { REPLAY_POLICY_VERSION } from './relocate.ts';
import {
  buildTraceCacheKey,
  createCallIndexer,
  projectIdentity,
  traceCacheKeyHash,
  traceCallSignature,
  type CacheTargetIdentity,
  type TraceCacheKind,
} from './identity.ts';
import { FileTraceCacheStore, MAX_CACHE_WIRE_BYTES, type TraceCacheStore } from './store.ts';
import type { ActionTrace } from './trace.ts';
import type { JsonValue } from '../types.ts';

/** One trace write held back until the attempt confirms or implicates it. */
export interface StagedTraceWrite {
  readonly keyHash: string;
  readonly trace: ActionTrace;
  /** Index of the recording step in the attempt's step timeline. */
  readonly stepIndex: number;
}

export interface AgentCacheContext {
  readonly mode: 'read-only' | 'read-write';
  readonly store: TraceCacheStore;
  /** Test and target a write is recorded for, as `e2e cache ls` prints them. */
  readonly identity: { readonly testId: string; readonly targetId: string };
  /** Whether this attempt may replay; writes are governed by `mode` alone. */
  readonly replayEligible: boolean;
  /**
   * Claims one step's key hash. Not a pure derivation: each claim advances
   * the per-attempt occurrence index for its signature, which is what lets a
   * test repeat the same instruction and cache each occurrence separately.
   * Exactly one claim per dispatched step, in execution order — the
   * `StepTraceSession` constructor is the sole caller and owns that
   * invariant structurally.
   */
  claimKeyHash(
    kind: TraceCacheKind,
    instruction: string,
    params: Readonly<Record<string, JsonValue>> | undefined,
  ): string;
  /**
   * Trace writes staged during the attempt. A trace is not trusted the moment
   * its own step passes — the verification step after it is what proves the
   * flow reached the right state. The runner settles at attempt end via
   * `flushStagedTraces`.
   */
  readonly staged: StagedTraceWrite[];
}

/**
 * Settles the attempt's staged trace writes. A staged trace is confirmed only
 * when a verification step — a deterministic assertion or an agent judgment
 * (`run/steps.ts`, `StepRunOptions.verifies`) — passed after it: an act's own
 * verdict is the recording executor's opinion of its work, and a later act
 * passing says only that the executor coped with whatever state it found. A
 * passing attempt confirms nothing by itself, so a flow no assertion ever
 * checked is never replayed blind, and a failing attempt confirms exactly
 * what had been verified before the failure landed. An unconfirmed trace is
 * not merely withheld: its entry is evicted, so a cached flow implicated in
 * a failure — or one that was never checked — re-records on the next pass
 * instead of replaying a poisoned state forever. The runner does not call
 * this for an interrupted attempt: interruption implicates nothing, so it
 * writes nothing and evicts nothing.
 */
export async function flushStagedTraces(
  context: AgentCacheContext,
  lastVerifiedStepIndex: number,
): Promise<void> {
  const staged = context.staged.splice(0);
  if (context.mode !== 'read-write') return;
  for (const write of staged) {
    const confirmed = write.stepIndex < lastVerifiedStepIndex;
    try {
      if (confirmed) await context.store.write(write.keyHash, write.trace);
      else await context.store.delete?.(write.keyHash);
    } catch {
      // The cache is disposable; a failed flush is a slower next run only.
    }
  }
}

/**
 * Builds one attempt's cache context, or undefined when the cache is off.
 * A configured custom store replaces the file store wholesale — that is the
 * seam a cloud-shared store (Redis, an API) plugs into. Its hits are
 * re-validated at the one read site (`StepTraceSession.begin`), like
 * every other store's.
 */
export function createAgentCacheContext(options: {
  readonly cache: ResolvedCacheConfig;
  readonly projectId: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly attemptIndex: number;
}): AgentCacheContext | undefined {
  const mode = options.cache.mode;
  if (mode === 'off') return undefined;
  const store =
    options.cache.store ??
    new FileTraceCacheStore({
      directory: options.cache.dir,
      maxBytes: MAX_CACHE_WIRE_BYTES,
      writable: mode === 'read-write',
    });
  const project = projectIdentity(options.projectId);
  const nextCallIndex = createCallIndexer();
  return {
    mode,
    store,
    identity: { testId: options.testId, targetId: options.target.targetId },
    replayEligible: options.attemptIndex === 0,
    claimKeyHash: (kind, instruction, params) => {
      const signature = traceCallSignature(kind, instruction, params);
      return traceCacheKeyHash(
        buildTraceCacheKey({
          project,
          testId: options.testId,
          target: options.target,
          signature,
          callIndex: nextCallIndex(signature),
          policyVersion: REPLAY_POLICY_VERSION,
        }),
      );
    },
    staged: [],
  };
}
