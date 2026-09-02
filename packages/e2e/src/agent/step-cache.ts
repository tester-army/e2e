/**
 * One step's trace-cache session (RFC0001 layer 3, cache-in decision): key
 * derivation, the replay attempt, live recording, and staging — everything
 * cache-shaped about one dispatched act step, kept beside the dispatch rather
 * than threaded through it. The dispatch owns budgets, the grammar, and the
 * verdict; this class owns nothing but the cache.
 */

import type { AgentCacheContext } from '../cache/context.ts';
import { decideTraceReplay, opensWithNavigate, type TraceReplayMissReason } from '../cache/decide.ts';
import { TraceRecorder, type RecordableAction } from '../cache/recorder.ts';
import type { StepCacheInfo } from '../run/steps.ts';
import type { JsonValue } from '../types.ts';
import type { ReplayedPrefix, StepVerdict } from './executor.ts';
import { replayTrace, type ReplayHost } from './replay.ts';

/**
 * The replay host plus the one session-level probe replay itself never
 * needs: the current location path, read once per step for the start-anchor
 * precondition.
 */
export interface StepCacheHost extends ReplayHost {
  currentPath(): Promise<string | undefined>;
}

/** What the session needs from the dispatch beyond the replay host itself. */
export interface StepCacheOptions {
  readonly cache: AgentCacheContext;
  readonly instruction: string;
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
  readonly executor: { readonly name: string; readonly version?: string };
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
  readonly maxActions: number;
  /** Timeline index of the step being dispatched. */
  readonly stepIndex: number;
}

export class StepTraceSession {
  private readonly cache: AgentCacheContext;
  private readonly keyHash: string;
  private readonly recorder: TraceRecorder | undefined;
  private readonly options: StepCacheOptions;
  private info: StepCacheInfo | undefined;
  private prefix: ReplayedPrefix | undefined;
  private startPath: string | undefined;
  /** Original producer of a fully replayed trace, kept as write provenance. */
  private replaySource: { name: string; version?: string } | undefined;
  /**
   * The replayed trace's original verdict prose, kept for the re-stage. The
   * step's own summary after a replay is the synthesized "replayed N
   * actions…" wrapper; storing that would nest the summary one level deeper
   * on every replay until the bound truncated it.
   */
  private replaySummary: string | undefined;
  /** True once a cached entry's actions were run this step, fully or partly. */
  private consumedReplay = false;

  constructor(options: StepCacheOptions) {
    this.options = options;
    this.cache = options.cache;
    this.keyHash = options.cache.claimKeyHash('act', options.instruction, options.params);
    if (options.cache.mode === 'read-write') {
      this.recorder = new TraceRecorder({
        redact: options.redact,
        testIdAttribute: options.testIdAttribute,
        maxActions: options.maxActions,
      });
    }
  }

  /** How the cache participated, for the step's report detail. */
  get cacheInfo(): StepCacheInfo | undefined {
    return this.info;
  }

  /** The mid-step hand-off, when a replay diverged after real progress. */
  get replayedPrefix(): ReplayedPrefix | undefined {
    return this.prefix;
  }

  /** Records one committed grammar action into the step trace. */
  record(action: RecordableAction): void {
    this.recorder?.record(action);
  }

  /** Records one mutating project-tool call as a replay-ending gap. */
  recordGap(toolName: string): void {
    this.recorder?.recordGap(toolName);
  }

  /**
   * Attempts a zero-turn replay. Returns the self-finalized verdict on a full
   * replay; undefined dispatches the executor — after a miss from the top,
   * after a divergence mid-step with `replayedPrefix` set. Every failure to
   * replay is a miss, never an error; only runtime hard stops propagate.
   */
  async tryReplay(host: StepCacheHost): Promise<StepVerdict | undefined> {
    // Captured before any action for the write's start-path precondition, and
    // doubling as the replay decision's current path.
    this.startPath = await host.currentPath();
    if (!this.cache.replayEligible) return undefined;
    let read: Awaited<ReturnType<typeof this.cache.store.read>>;
    try {
      read = await this.cache.store.read(this.keyHash);
    } catch {
      // A store outage is a slower run, never a failed test: the read
      // degrades to a miss and the live executor runs.
      read = { status: 'invalid', reason: 'store read failed' };
    }
    if (read.status !== 'hit') {
      this.info = this.missed(read.status === 'miss' ? 'no-entry' : 'invalid-entry', 0);
      return undefined;
    }
    const trace = read.entry.payload;
    const decision = decideTraceReplay(read.entry, this.startPath);
    if (decision.action === 'miss') {
      this.info = this.missed(decision.reason, trace.actions.length);
      return undefined;
    }
    const outcome = await replayTrace(host, trace);
    this.consumedReplay = true;
    if (outcome.completed) {
      // The recorded end path is the trace's postcondition: a flow whose
      // destination changed replays mechanically but must not pass on its
      // own — the executor gets the step and judges the live state instead.
      const endMismatch =
        trace.endPath !== undefined && !samePathname(await host.currentPath(), trace.endPath);
      if (!endMismatch) {
        this.replaySource = { ...trace.executor };
        this.replaySummary = trace.summary;
        this.info = {
          mode: 'self-finalized',
          replayedActions: outcome.executed,
          totalActions: outcome.total,
        };
        return {
          status: 'passed',
          summary: `replayed ${outcome.executed} recorded action(s) zero-turn from the trace cache; recorded verdict: ${trace.summary}`,
        };
      }
      this.prefix = {
        replayedActions: outcome.summaries,
        totalActions: outcome.total,
        stopReason: 'end-mismatch',
      };
      this.info = {
        mode: 'agent-concluded',
        reason: 'end-mismatch',
        replayedActions: outcome.executed,
        totalActions: outcome.total,
      };
      return undefined;
    }
    const stopReason = outcome.stopReason ?? 'action-failed';
    if (outcome.executed === 0) {
      // A prefix that performed nothing is a miss with a name, not a hand-off:
      // the executor starts from the top and owes the notice nothing.
      this.info = this.missed(stopReason, outcome.total);
      return undefined;
    }
    this.prefix = {
      replayedActions: outcome.summaries,
      totalActions: outcome.total,
      stopReason,
      ...(outcome.uncertainAction === undefined ? {} : { uncertainAction: outcome.uncertainAction }),
    };
    this.info = {
      mode: 'agent-concluded',
      reason: stopReason,
      replayedActions: outcome.executed,
      totalActions: outcome.total,
    };
    return undefined;
  }

  /**
   * Stages this step's recorded trace after a passed verdict, in read-write
   * mode only. The write is deferred, not immediate: the trace is confirmed
   * or evicted at attempt end (`flushStagedTraces`), because the
   * deterministic assertion after the step — not the verdict alone — is what
   * proves the flow reached the right state. A replayed step re-stages its
   * own entry with fresh descriptors, which is how staleness self-heals.
   */
  stage(verdictSummary: string | undefined, endPath: string | undefined): void {
    if (this.recorder === undefined) return;
    const trace = this.recorder.finalize({
      executor: this.replaySource ?? this.options.executor,
      // A self-finalized replay re-stages the ORIGINAL verdict prose; the
      // step's own summary is the synthesized replay wrapper.
      summary: this.replaySummary ?? verdictSummary ?? 'step passed',
      ...(this.startPath === undefined ? {} : { startPath: this.startPath }),
      ...(endPath === undefined ? {} : { endPath }),
    });
    if (trace === undefined) return;
    // A trace with no start anchor — no recorded path (a surface without a URL)
    // and no opening navigate — could never replay: `wrong-context` forever.
    // Writing it would be pure store traffic, so it is not written at all.
    if (trace.startPath === undefined && !opensWithNavigate(trace)) return;
    this.cache.staged.push({ keyHash: this.keyHash, trace, stepIndex: this.options.stepIndex });
  }

  /**
   * Evicts the entry whose replay this step consumed, called when the step
   * settles non-passed. Without this, a diverged replay whose step then fails
   * stages nothing — and the poisoned entry would replay its bad prefix on
   * every future first attempt.
   */
  async evictOnFailure(): Promise<void> {
    if (!this.consumedReplay || this.cache.mode !== 'read-write') return;
    await this.cache.store.delete?.(this.keyHash).catch(() => undefined);
  }

  /** Whether staging would write anything; gates the end-path location read. */
  get wantsStage(): boolean {
    return this.recorder !== undefined;
  }

  private missed(reason: TraceReplayMissReason | ReplayedPrefix['stopReason'], totalActions: number): StepCacheInfo {
    return { mode: 'missed', reason, replayedActions: 0, totalActions };
  }
}

/** Pathname-only comparison: volatile query strings must not break zero-turn. */
function samePathname(current: string | undefined, recorded: string): boolean {
  if (current === undefined) return true;
  const pathOf = (value: string): string => value.split('?')[0] ?? value;
  return pathOf(current) === pathOf(recorded);
}
