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
  keyContext,
  projectIdentity,
  traceCacheKeyHash,
  traceCallSignature,
  type CacheAgentIdentity,
  type CacheTargetIdentity,
  type TraceCacheKind,
  type TraceCallSignature,
} from './identity.ts';
import type { StoredRecordings } from './rekeyed.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES, type CacheStore } from './store.ts';
import type { ActionTrace, TraceKeyContext, TraceProvenance } from './trace.ts';
import type { JsonValue } from '../types.ts';

/**
 * One cache entry held back until the attempt confirms or implicates it: a
 * recording to write, or an entry the step replayed whole to keep as it
 * stands. A kept entry carries no payload, so the replay's expansion of it
 * (every `unique()` slot filled with this run's value) can never be written;
 * confirmed, the file keeps its bytes and `createdAt`, and a committed cache
 * directory stays clean, unless its provenance predates the step's
 * occurrence fields (`recordedFor`, as stored), which the replay proved and
 * are then written in. Unconfirmed, both kinds are evicted alike.
 */
export type StagedTrace = {
  readonly keyHash: string;
  /** Index of the step in the attempt's step timeline. */
  readonly stepIndex: number;
} & (
  | { readonly kind: 'write'; readonly trace: ActionTrace }
  | { readonly kind: 'keep'; readonly recordedFor: TraceProvenance; readonly keyedBy: TraceKeyContext }
);

/** One step's claimed key: its hash, and the step it names as an entry records it. */
export interface ClaimedKey {
  readonly keyHash: string;
  /** The key's parts outside the step, recorded with the entry so a later key change can be named. */
  readonly context: TraceKeyContext;
  /** The step's identity before redaction; the recorder redacts it on the way to disk. */
  readonly step: TraceProvenance;
}

export interface AgentCacheContext {
  readonly mode: 'read-only' | 'read-write';
  readonly store: CacheStore;
  /** Whether this attempt may replay; writes are governed by `mode` alone. */
  readonly replayEligible: boolean;
  /**
   * A recording that no longer replays fails its step (`REPLAY_STALE`)
   * instead of handing it to the executor, with `advice` on how to re-record
   * it: the knobs to turn off and where the entry lives. `recordings`, set
   * when the store can be listed, finds the recording of a step whose key
   * changed under it, which is stale too rather than missing.
   */
  readonly strict: false | { readonly advice: string; readonly recordings?: StoredRecordings };
  /**
   * Claims one step's key. Not a pure derivation: each claim advances
   * the per-attempt occurrence index for its agent and signature, which is
   * what lets a test repeat the same instruction and cache each occurrence
   * separately.
   * Exactly one claim per dispatched step, in execution order — the
   * `StepTraceSession` constructor is the sole caller and owns that
   * invariant structurally.
   */
  claimKey(
    kind: TraceCacheKind,
    instruction: string,
    params: Readonly<Record<string, JsonValue>> | undefined,
    agent: CacheAgentIdentity,
  ): ClaimedKey;
  /**
   * Trace writes staged during the attempt. A trace is not trusted the moment
   * its own step passes — the verification step after it is what proves the
   * flow reached the right state. The runner settles at attempt end via
   * `flushStagedTraces`.
   */
  readonly staged: StagedTrace[];
  /**
   * What became of each step's recording, by step index: decided when the
   * step concludes (an eviction, nothing to record) or when the attempt
   * settles what it staged. The report shows it beside the step's cache mode.
   */
  readonly writes: Map<number, CacheWrite>;
}

/**
 * What became of a step's recording. `saved`: written for the next run.
 * `kept`: the entry it replayed, or one holding the same flow, stays as it
 * is. `unconfirmed`: not saved, because no check passed after the step.
 * `evicted`: the entry was deleted, since it replayed into a failure or a
 * repair. `no-change`: the step passed but changed nothing a replay could
 * check, so there was nothing to record.
 */
export type CacheWrite = 'saved' | 'kept' | 'unconfirmed' | 'evicted' | 'no-change';

/**
 * Whether the store already holds this flow: the same actions, paths, anchors,
 * executor, and provenance. The model's summary, the measured end wait, the
 * key context it was recorded under (which an older entry lacks), and
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
  const { summary: _summary, endWaitMs: _endWaitMs, keyedBy: _keyedBy, actions, ...flow } = trace;
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
 * Writes the step's full provenance into a kept entry recorded before the
 * occurrence fields or the key context were, leaving every other entry
 * untouched. Its replay proved which step it belongs to, and `cache.strict`
 * matches only entries that say so exactly (`rekeyed.ts`); the key context
 * lets a later key change be named.
 */
async function completeProvenance(
  store: CacheStore,
  keyHash: string,
  recordedFor: TraceProvenance | undefined,
  keyedBy: TraceKeyContext,
): Promise<void> {
  const existing = await store.read(keyHash);
  if (existing.status !== 'hit') return;
  const { payload } = existing.entry;
  const owesStep = recordedFor !== undefined && payload.recordedFor?.callIndex === undefined;
  const owesKey = payload.keyedBy === undefined;
  if (!owesStep && !owesKey) return;
  await store.write(keyHash, { ...payload, ...(owesStep ? { recordedFor } : {}), ...(owesKey ? { keyedBy } : {}) });
}

/** How an attempt ended, as the settlement of its staged entries reads it. */
export interface AttemptSettlement {
  /** Entries staged before this step index were verified, and are confirmed. */
  readonly lastVerifiedStepIndex: number;
  /**
   * Whether the attempt implicates the entries it did not confirm. False when
   * its failure is that no model answered (`isModelUnreachable`), a verdict
   * on the provider and never on the app: unconfirmed entries are then left
   * exactly as they are, neither written nor evicted.
   */
  readonly implicatesUnconfirmed: boolean;
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
 * instead of replaying a poisoned state forever, unless the settlement says
 * the failure implicates nothing unconfirmed. The runner does not call this
 * for an interrupted attempt: interruption implicates nothing, so it writes
 * nothing and evicts nothing. An entry a step replayed whole is staged too,
 * so the same rule evicts it when nothing confirmed it; when something did,
 * it is left exactly as it was found, but for provenance it lacked.
 */
export async function flushStagedTraces(context: AgentCacheContext, settlement: AttemptSettlement): Promise<void> {
  const staged = context.staged.splice(0);
  if (context.mode !== 'read-write') return;
  for (const entry of staged) {
    const confirmed = entry.stepIndex < settlement.lastVerifiedStepIndex;
    try {
      if (!confirmed) {
        // A kept entry existed for certain, so deleting it is an eviction; a
        // new recording's delete only clears what an earlier run may have left.
        context.writes.set(entry.stepIndex, entry.kind === 'keep' && settlement.implicatesUnconfirmed ? 'evicted' : 'unconfirmed');
        if (settlement.implicatesUnconfirmed) await context.store.delete?.(entry.keyHash);
        continue;
      }
      if (entry.kind === 'keep') {
        context.writes.set(entry.stepIndex, 'kept');
        await completeProvenance(context.store, entry.keyHash, entry.recordedFor, entry.keyedBy);
        continue;
      }
      if (await holdsSameFlow(context.store, entry.keyHash, entry.trace)) {
        context.writes.set(entry.stepIndex, 'kept');
        if (entry.trace.keyedBy !== undefined) await completeProvenance(context.store, entry.keyHash, entry.trace.recordedFor, entry.trace.keyedBy);
        continue;
      }
      await context.store.write(entry.keyHash, entry.trace);
      context.writes.set(entry.stepIndex, 'saved');
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
  /** The file store's listing under `cache.strict`, shared by the attempts of one worker and target (`storedRecordingsFor`). */
  readonly recordings?: StoredRecordings | undefined;
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
  // One occurrence count per agent: the agent is part of the key, so another
  // agent's call of the same instruction must not renumber this one's.
  const indexers = new Map<string, ReturnType<typeof createCallIndexer>>();
  const nextCallIndex = (agent: CacheAgentIdentity, signature: TraceCallSignature): number => {
    // Folded like the key folds it (`buildTraceCacheKey`): no context is the empty one.
    const agentKey = canonicalJson([agent.name, agent.context ?? '']);
    const indexer = indexers.get(agentKey) ?? createCallIndexer();
    indexers.set(agentKey, indexer);
    return indexer(signature);
  };
  return {
    mode,
    store,
    replayEligible: options.attemptIndex === 0,
    strict:
      options.cache.strict === false
        ? false
        : {
            advice: staleAdvice(options.cache, options.cache.strict, options.projectRoot),
            ...(options.recordings === undefined ? {} : { recordings: options.recordings }),
          },
    claimKey: (kind, instruction, params, agent) => {
      const signature = traceCallSignature(kind, instruction, params);
      const callIndex = nextCallIndex(agent, signature);
      const key = buildTraceCacheKey({
        project,
        testId: options.testId,
        target: options.target,
        signature,
        callIndex,
        agent,
        policyVersion: REPLAY_POLICY_VERSION,
      });
      return {
        keyHash: traceCacheKeyHash(key),
        context: keyContext(key),
        step: {
          testId: options.testId,
          targetId: options.target.targetId,
          instructionDigest: signature.instructionDigest,
          paramsDigest: signature.paramsDigest,
          callIndex,
          agent: agent.name,
        },
      };
    },
    staged: [],
    writes: new Map(),
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
