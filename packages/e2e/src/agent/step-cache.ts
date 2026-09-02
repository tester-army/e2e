/**
 * One step's trace-cache session (RFC0001 layer 3, cache-in decision): key
 * derivation, the replay attempt, live recording, and staging — everything
 * cache-shaped about one dispatched act step, kept beside the dispatch rather
 * than threaded through it. The dispatch owns budgets, the grammar, and the
 * verdict; this class owns nothing but the cache.
 */

import { describeAnchors } from '../cache/anchors.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import { decideTraceReplay, opensWithNavigate, type TraceReplayMissReason } from '../cache/decide.ts';
import { TraceRecorder } from '../cache/recorder.ts';
import { readTraceEntry } from '../cache/trace.ts';
import type { SemanticNode } from '../backend/surface.ts';
import type { StepCacheInfo } from '../run/steps.ts';
import type { JsonValue } from '../types.ts';
import type { RecordableAction } from './actions.ts';
import { isAgentError } from './error.ts';
import { RUNTIME_CODES, type ReplayedPrefix, type StepVerdict } from './executor.ts';
import { replayTrace, verifyAnchors, type ReplayHost } from './replay.ts';

/**
 * The replay host plus the two session-level probes replay itself never
 * needs: the current location path, read once per step for the start-anchor
 * precondition, and one settled look at the screen before any action — the
 * baseline the staged trace's end anchors are the delta from. The settled
 * observe is the dispatch's own (one recorded observation, settling inside),
 * not replay's raw polling loop, so the baseline costs the step one event.
 */
export interface StepCacheHost extends ReplayHost {
  currentPath(): Promise<string | undefined>;
  observeSettledNodes(): Promise<ReadonlyMap<string, SemanticNode>>;
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
  /**
   * The screen before any action, kept only when this step may write: the
   * staged trace's end anchors are the delta between this and the passing
   * observation, so a replay must reproduce the step's effect to pass alone.
   */
  private startNodes: ReadonlyMap<string, SemanticNode> | undefined;
  /**
   * True when the baseline could not be captured for a reason that is not the
   * step's own hard stop. The step still runs — an executor that never looks
   * at the screen owes the cache nothing — but nothing is staged: a trace
   * without its baseline has no anchors, and would replay on mechanics alone.
   */
  private baselineUnavailable = false;
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
  /** Grammar actions recorded so far when an end-mismatch hand-off happened. */
  private actionsAtEndMismatch: number | undefined;

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
    if (this.recorder !== undefined) {
      try {
        this.startNodes = await host.observeSettledNodes();
      } catch (cause) {
        // Runtime hard stops (timeout, cancellation) are the step's truth and
        // propagate; anything else means the surface cannot be observed right
        // now, which is the executor's business, not the cache's.
        if (isAgentError(cause) && RUNTIME_CODES.has(cause.code)) throw cause;
        this.baselineUnavailable = true;
      }
    }
    if (!this.cache.replayEligible) return undefined;
    let read: Awaited<ReturnType<typeof this.cache.store.read>>;
    try {
      read = await this.cache.store.read(this.keyHash);
    } catch {
      // A store outage is a slower run, never a failed test: the read
      // degrades to a miss and the live executor runs.
      read = { status: 'invalid', reason: 'store read failed' };
    }
    if (read.status === 'hit') {
      // Every hit is re-validated through the trace-1 framing, whichever
      // store produced it: a custom store's entry can never be trusted more
      // loosely than a file entry, however the store author built their read
      // path. An entry that fails degrades to `invalid` — fail-to-miss.
      const entry = readTraceEntry(read.entry);
      read =
        entry === undefined
          ? { status: 'invalid', reason: 'the store returned a non-trace-1 entry' }
          : { ...read, entry };
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
      // The recorded end path and end anchors are the trace's postcondition:
      // a flow whose destination changed, or whose effect is not on screen
      // again, replays mechanically but must not pass on its own — the
      // executor gets the step and judges the live state instead. Actions
      // that all ran prove the clicks happened; only the anchors prove the
      // save took.
      const endMismatch =
        (trace.endPath !== undefined && !samePathname(await host.currentPath(), trace.endPath)) ||
        !(await verifyAnchors(host, trace.endAnchors ?? []));
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
      this.actionsAtEndMismatch = this.recorder?.recordedCount ?? 0;
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
   *
   * `endNodes` is the passing observation; its delta against the starting
   * one becomes the trace's end anchors. When the step moved to another
   * pathname the whole screen is the delta and the path is the postcondition,
   * so anchors are recorded only for a step that ended where it began (or on
   * a surface without a location at all, where they are the only check).
   */
  async stage(
    verdictSummary: string | undefined,
    endPath: string | undefined,
    endNodes: ReadonlyMap<string, SemanticNode> | undefined,
  ): Promise<void> {
    if (this.recorder === undefined || this.baselineUnavailable) return;
    if (this.repairedAfterEndMismatch) {
      // Every recorded action ran and the effect was still missing, and the
      // executor had to act further to get there: the recorded flow is proven
      // not to produce its effect. Re-staging would freeze the failed flow
      // plus its repair — a typo, its deletion, the retype — as the thing to
      // replay forever. Evict instead; the next pass records a clean flow.
      // A hand-off the executor settled without acting is different: the
      // flow was fine and only the anchors were stale, so it heals below.
      // Awaited so the step does not close — and a later read cannot be
      // served the stale flow — before the eviction has settled.
      await this.cache.store.delete?.(this.keyHash).catch(() => undefined);
      return;
    }
    const endAnchors =
      this.startNodes === undefined || endNodes === undefined || movedPathname(this.startPath, endPath)
        ? undefined
        : describeAnchors(this.startNodes, endNodes, {
            redact: this.options.redact,
            testIdAttribute: this.options.testIdAttribute,
          });
    const trace = this.recorder.finalize({
      executor: this.replaySource ?? this.options.executor,
      // A self-finalized replay re-stages the ORIGINAL verdict prose; the
      // step's own summary is the synthesized replay wrapper.
      summary: this.replaySummary ?? verdictSummary ?? 'step passed',
      ...(this.startPath === undefined ? {} : { startPath: this.startPath }),
      ...(endPath === undefined ? {} : { endPath }),
      ...(endAnchors === undefined ? {} : { endAnchors }),
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

  private get repairedAfterEndMismatch(): boolean {
    return (
      this.actionsAtEndMismatch !== undefined &&
      (this.recorder?.recordedCount ?? 0) > this.actionsAtEndMismatch
    );
  }

  private missed(reason: TraceReplayMissReason | ReplayedPrefix['stopReason'], totalActions: number): StepCacheInfo {
    return { mode: 'missed', reason, replayedActions: 0, totalActions };
  }
}

/** Pathname-only comparison: volatile query strings must not break zero-turn. */
function samePathname(current: string | undefined, recorded: string): boolean {
  if (current === undefined) return true;
  return pathOf(current) === pathOf(recorded);
}

/** True only when both locations are known and their pathnames differ. */
function movedPathname(start: string | undefined, end: string | undefined): boolean {
  return start !== undefined && end !== undefined && pathOf(start) !== pathOf(end);
}

function pathOf(value: string): string {
  return value.split('?')[0] ?? value;
}
