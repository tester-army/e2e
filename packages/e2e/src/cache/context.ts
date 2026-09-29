/**
 * Per-attempt cache context.
 *
 * Built by the runner once per attempt and handed to the agent tier: the
 * resolved store, key derivation over the attempt's fixed identity, and the
 * staging ground for trace writes. Replay is eligible only on a first attempt
 * — a retry exists because something already went wrong, so it runs fresh and
 * re-records.
 */

import path from 'node:path';
import type { CacheStrictSource, ResolvedCacheConfig } from '../config/resolve.ts';
import { canonicalJson } from '../internal/ids.ts';
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
import { FileCacheStore, MAX_CACHE_WIRE_BYTES, type CacheStore } from './store.ts';
import type { ActionTrace } from './trace.ts';
import type { JsonValue } from '../types.ts';

/**
 * One cache entry held back until the attempt confirms or implicates it: a
 * recording to write, or an entry the step replayed whole to keep as it
 * stands. A kept entry carries no payload, so the replay's expansion of it
 * (every `unique()` slot filled with this run's value) can never be written;
 * confirmed, the file keeps its bytes and `createdAt`, and a committed cache
 * directory stays clean. Unconfirmed, both kinds are evicted alike.
 */
export type StagedTrace = {
  readonly keyHash: string;
  /** Index of the step in the attempt's step timeline. */
  readonly stepIndex: number;
} & (
  | { readonly kind: 'write'; readonly trace: ActionTrace }
  | { readonly kind: 'keep' }
);

export interface AgentCacheContext {
  readonly mode: 'read-only' | 'read-write';
  readonly store: CacheStore;
  /** Test and target a write is recorded for, as `e2e cache ls` prints them. */
  readonly identity: { readonly testId: string; readonly targetId: string };
  /** Whether this attempt may replay; writes are governed by `mode` alone. */
  readonly replayEligible: boolean;
  /**
   * A recording that no longer replays fails its step (`REPLAY_STALE`)
   * instead of handing it to the executor, with `advice` on how to re-record
   * it: the knobs to turn off and where the entry lives.
   */
  readonly strict: false | { readonly advice: string };
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
  readonly staged: StagedTrace[];
}

/**
 * Whether the store already holds this flow: the same actions, paths, anchors,
 * executor, and provenance. The model's summary, the measured end wait, and
 * the rule that flagged a gap's typed value (`derived`, which follows how the
 * agent read the value this time) differ between live runs, so a step that
 * runs live each time (it types a value read off the screen) would otherwise
 * rewrite an entry a committed cache directory carries. A replay stops at a
 * gap whatever its rule, which only names the hand-off in the report.
 */
async function holdsSameFlow(store: CacheStore, keyHash: string, trace: ActionTrace): Promise<boolean> {
  const existing = await store.read(keyHash);
  return existing.status === 'hit' && flowOf(existing.entry.payload) === flowOf(trace);
}

/** The part of a trace that decides what a replay does, as canonical JSON. */
function flowOf(trace: ActionTrace): string {
  const { summary: _summary, endWaitMs: _endWaitMs, actions, ...flow } = trace;
  return canonicalJson({
    ...flow,
    actions: actions.map((action) => {
      if (action.name !== 'tool') return action;
      const { derived: _derived, ...gap } = action;
      return gap;
    }),
  });
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
 * writes nothing and evicts nothing. An entry a step replayed whole is
 * staged too, so the same rule evicts it when nothing confirmed it; when
 * something did, it is left exactly as it was found.
 */
export async function flushStagedTraces(
  context: AgentCacheContext,
  lastVerifiedStepIndex: number,
): Promise<void> {
  const staged = context.staged.splice(0);
  if (context.mode !== 'read-write') return;
  for (const entry of staged) {
    const confirmed = entry.stepIndex < lastVerifiedStepIndex;
    try {
      switch (entry.kind) {
        case 'write':
          if (!confirmed) {
            await context.store.delete?.(entry.keyHash);
            break;
          }
          if (await holdsSameFlow(context.store, entry.keyHash, entry.trace)) break;
          await context.store.write(entry.keyHash, entry.trace);
          break;
        case 'keep':
          if (!confirmed) await context.store.delete?.(entry.keyHash);
          break;
      }
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
  readonly projectRoot: string;
  readonly projectId: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly attemptIndex: number;
}): AgentCacheContext | undefined {
  const mode = options.cache.mode;
  if (mode === 'off') return undefined;
  const store =
    options.cache.store ??
    new FileCacheStore({
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
    strict: options.cache.strict === false ? false : { advice: staleAdvice(options.cache, options.cache.strict, options.projectRoot) },
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

/**
 * How to re-record a recording `cache.strict` failed on: a read-write run
 * with every knob that turned strict on turned off, and where the new entry
 * lands, as the project names it.
 */
function staleAdvice(cache: ResolvedCacheConfig, source: CacheStrictSource, projectRoot: string): string {
  const off = [
    ...(source.flag ? ['without --strict-cache'] : []),
    ...(source.config ? ['with cache.strict set to false'] : []),
  ].join(' and ');
  const run = `re-record it with a read-write run ${off}`;
  if (cache.store !== undefined) return `${run}; the run writes the new entry to the configured cache.store`;
  const relative = path.relative(projectRoot, cache.dir);
  const where = relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? cache.dir : relative;
  return `${run} and commit the changed entry under ${where.split(path.sep).join('/')}`;
}
