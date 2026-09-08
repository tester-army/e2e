/**
 * One step's trace-cache session: key
 * derivation, the replay attempt, live recording, and the stage-or-evict
 * decision once the step has settled — everything cache-shaped about one
 * dispatched act step, kept beside the dispatch rather than threaded through
 * it. The dispatch owns budgets, the grammar, and the verdict; this class owns
 * nothing but the cache.
 *
 * Cost: in read-write mode the session takes two settled looks at the screen
 * the executor never asked for — one before any action, one after the passing
 * verdict — because the trace's end anchors are the delta between them. A
 * read-only run pays neither.
 */

import { describeAnchors } from '../cache/anchors.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import {
  decideTraceReplay,
  opensWithNavigate,
  samePathname,
  type TraceReplayMissReason,
} from '../cache/decide.ts';
import { instructionDigest } from '../cache/identity.ts';
import { TraceRecorder } from '../cache/recorder.ts';
import { readTraceEntry, type ActionTrace, type TraceEntry } from '../cache/trace.ts';
import { sleep } from '../internal/time.ts';
import type { StepCacheInfo } from '../run/steps.ts';
import type { JsonValue } from '../types.ts';
import type { RecordableAction } from './actions.ts';
import { isRuntimeHardStop, type ReplayedPrefix, type StepVerdict } from './executor.ts';
import {
  replayTrace,
  verifyAnchors,
  type ObservedNodes,
  type ReplayHost,
  type ReplayOutcome,
} from './replay.ts';

/**
 * The replay host plus the one session-level probe replay itself never needs:
 * the current location path, read at both ends of the step for the trace's
 * start-path precondition and end-path postcondition.
 */
export interface StepCacheHost extends ReplayHost {
  currentPath(observation?: ObservedNodes): Promise<string | undefined>;
}

/** What the session needs from the dispatch beyond the host itself. */
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

/** How the step settled, as the write-side decision sees it. */
export type StepOutcome = 'passed' | 'failed' | 'cancelled';

type HandOffReason = ReplayedPrefix['stopReason'];

type EntryRead =
  | { readonly status: 'hit'; readonly entry: TraceEntry }
  | { readonly status: 'miss'; readonly reason: 'no-entry' | 'invalid-entry' };

/** Margin added to a recorded step's duration when replay waits for its end state. */
const END_WAIT_MARGIN_MS = 10_000;
/**
 * How long a replay waits for a recorded destination path to be the current
 * one. A step that moved records no anchors: the path is its whole
 * postcondition, and the replayed tap that starts the navigation returns
 * before the new document commits. Reading the path once, right after the
 * tap, hands every navigation off as an end-mismatch; polling with the
 * settling backoff lets the destination arrive. Bounded like anchor polling.
 */
const END_PATH_DELAYS_MS = [100, 300, 600, 1_000, 3_000] as const;
const END_PATH_TIMEOUT_MS = 15_000;

export class StepTraceSession {
  private readonly host: StepCacheHost;
  private readonly cache: AgentCacheContext;
  private readonly keyHash: string;
  private readonly recorder: TraceRecorder | undefined;
  private readonly options: StepCacheOptions;
  private info: StepCacheInfo | undefined;
  private prefix: ReplayedPrefix | undefined;
  private startPath: string | undefined;
  private startedMs = Date.now();
  /**
   * The screen before any action, captured only when this step may write: the
   * staged trace's end anchors are the delta between this and the passing
   * observation, so a replay must reproduce the step's effect to pass alone.
   * Undefined after `begin` when the surface could not be observed; the step
   * still runs — an executor that never looks at the screen owes the cache
   * nothing — but nothing is staged, because a trace without its baseline has
   * no anchors and would replay on mechanics alone.
   */
  private startNodes: ObservedNodes | undefined;
  /**
   * The trace a full replay reproduced, kept for the re-stage: its executor
   * is the write's provenance, and its summary is the original verdict prose.
   * The step's own summary after a replay is the synthesized "replayed N
   * actions…" wrapper; storing that would nest the summary one level deeper
   * on every replay until the bound truncated it.
   */
  private replayed: ActionTrace | undefined;
  /** True once a cached entry's actions were run this step, fully or partly. */
  private consumedReplay = false;
  /** Grammar actions recorded so far when an end-mismatch hand-off happened. */
  private actionsAtEndMismatch: number | undefined;

  constructor(host: StepCacheHost, options: StepCacheOptions) {
    this.host = host;
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
   * Opens the step: captures the write-side preconditions — the start path
   * and, when this step may write, the baseline screen — then attempts a
   * zero-turn replay. Returns the self-finalized verdict on a full replay
   * whose postcondition holds; undefined dispatches the executor — after a
   * miss from the top, after a divergence mid-step with `replayedPrefix` set.
   * Every failure to replay is a miss, never an error; only runtime hard stops
   * propagate.
   */
  async begin(): Promise<StepVerdict | undefined> {
    this.startedMs = Date.now();
    // Captured before any action for the write's start-path precondition, and
    // doubling as the replay decision's current path.
    if (this.recorder !== undefined) this.startNodes = await probeScreen(this.host);
    this.startPath = await this.host.currentPath(this.startNodes);
    if (!this.cache.replayEligible) return undefined;

    const read = await this.readEntry();
    if (read.status === 'miss') {
      this.info = this.missed(read.reason, 0);
      return undefined;
    }
    const trace = read.entry.payload;
    const decision = decideTraceReplay(read.entry, this.startPath);
    if (decision.action === 'miss') {
      this.info = this.missed(decision.reason, trace.actions.length);
      return undefined;
    }

    const outcome = await replayTrace(this.host, trace);
    this.consumedReplay = true;
    // Actions that all ran prove the clicks happened; only the postcondition
    // proves the save took. A flow whose destination changed, or whose effect
    // is not on screen again, hands off like any other divergence.
    const stopReason: HandOffReason | undefined = outcome.completed
      ? (await this.endStateMatches(trace))
        ? undefined
        : 'end-mismatch'
      : (outcome.stopReason ?? 'action-failed');
    if (stopReason === undefined) return this.selfFinalize(trace, outcome);
    if (outcome.executed === 0) {
      // A prefix that performed nothing is a miss with a name, not a hand-off:
      // the executor starts from the top and owes the notice nothing.
      this.info = this.missed(stopReason, outcome.total);
      return undefined;
    }
    this.handOff(outcome, stopReason);
    return undefined;
  }

  /**
   * Closes the session once the step has settled. The whole write-side
   * decision lives here, in read-write mode only:
   *
   * - passed, after an end-mismatch the executor had to act to repair: evict.
   *   Every recorded action ran and the effect was still missing, so the
   *   recorded flow is proven not to produce it. Re-staging would freeze the
   *   failed flow plus its repair — a typo, its deletion, the retype — as the
   *   thing to replay forever; the next pass records a clean flow instead. A
   *   hand-off the executor settled without acting is different: the flow was
   *   fine and only the anchors were stale, so it heals by re-staging.
   * - passed otherwise: stage the recorded trace for attempt-end settlement.
   * - failed after consuming a replay: evict. Without this, a diverged replay
   *   whose step then fails stages nothing — and the poisoned entry would
   *   replay its bad prefix on every future first attempt.
   * - cancelled: nothing, exactly like an interrupted attempt.
   */
  async conclude(outcome: StepOutcome, verdictSummary: string | undefined): Promise<void> {
    const recorder = this.recorder;
    if (recorder === undefined) return;
    switch (outcome) {
      case 'cancelled':
        return;
      case 'failed':
        if (this.consumedReplay) await this.evict();
        return;
      case 'passed':
        if (this.repairedAfterEndMismatch(recorder)) await this.evict();
        else await this.stage(recorder, verdictSummary);
        return;
    }
  }

  /**
   * One store read, revalidated through the trace-1 framing whichever store
   * produced it: a custom store's entry can never be trusted more loosely
   * than a file entry, however the store author built their read path. A
   * store outage is a slower run, never a failed test — every failure to read
   * degrades to a miss.
   */
  private async readEntry(): Promise<EntryRead> {
    let read: Awaited<ReturnType<AgentCacheContext['store']['read']>>;
    try {
      read = await this.cache.store.read(this.keyHash);
    } catch {
      return { status: 'miss', reason: 'invalid-entry' };
    }
    if (read.status === 'miss') return { status: 'miss', reason: 'no-entry' };
    if (read.status === 'invalid') return { status: 'miss', reason: 'invalid-entry' };
    const entry = readTraceEntry(read.entry);
    return entry === undefined ? { status: 'miss', reason: 'invalid-entry' } : { status: 'hit', entry };
  }

  /**
   * The trace's postcondition against the live screen: the recorded end path
   * (pathname only, when the live location is known) and every recorded end
   * anchor present again.
   */
  private async endStateMatches(trace: ActionTrace): Promise<boolean> {
    if (trace.endPath !== undefined && !(await this.pathSettles(trace.endPath))) return false;
    return verifyAnchors(this.host, trace.endAnchors ?? [], trace.endWaitMs);
  }

  /** Whether the current path becomes `endPath` within the settling backoff. */
  private async pathSettles(endPath: string): Promise<boolean> {
    const startedMs = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const current = await this.host.currentPath();
      if (current === undefined || samePathname(current, endPath)) return true;
      const delay = END_PATH_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        Date.now() - startedMs + delay > END_PATH_TIMEOUT_MS ||
        this.host.remainingMs() <= delay ||
        this.host.signal.aborted
      ) {
        return false;
      }
      await sleep(delay, this.host.signal);
    }
  }

  private selfFinalize(trace: ActionTrace, outcome: ReplayOutcome): StepVerdict {
    this.replayed = trace;
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

  private handOff(outcome: ReplayOutcome, stopReason: HandOffReason): void {
    if (stopReason === 'end-mismatch') this.actionsAtEndMismatch = this.recorder?.recordedCount ?? 0;
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
  }

  /**
   * Stages the recorded trace for attempt-end settlement. The write is
   * deferred, not immediate: the trace is confirmed or evicted at attempt end
   * (`flushStagedTraces`), because the verification step after this one — not
   * the verdict alone — is what proves the flow reached the right state. A
   * replayed step re-stages its own entry with fresh descriptors, which is
   * how staleness self-heals.
   *
   * The end path and a fresh settled observation are the trace's
   * postcondition — the state the step passed in. The delta between the
   * baseline and the passing observation becomes the end anchors. When the
   * step moved to another pathname the whole screen is the delta and the path
   * is the postcondition, so anchors are recorded only for a step that ended
   * where it began (or on a surface without a location at all, where they are
   * the only check). A postcondition that cannot be captured stages nothing:
   * a trace without its check would replay on mechanics alone.
   */
  private async stage(recorder: TraceRecorder, verdictSummary: string | undefined): Promise<void> {
    if (this.startNodes === undefined) return;
    const endNodes = await probeScreen(this.host);
    if (endNodes === undefined) return;
    const endPath = await this.host.currentPath(endNodes);
    const moved =
      this.startPath !== undefined && endPath !== undefined && !samePathname(this.startPath, endPath);
    const endAnchors = moved ? undefined : describeAnchors(this.startNodes, endNodes, this.options);
    const trace = recorder.finalize({
      executor: this.replayed?.executor ?? this.options.executor,
      recordedFor: {
        testId: this.cache.identity.testId,
        targetId: this.cache.identity.targetId,
        instructionDigest: instructionDigest(this.options.instruction),
      },
      summary: this.replayed?.summary ?? verdictSummary ?? 'step passed',
      ...(this.startPath === undefined ? {} : { startPath: this.startPath }),
      ...(endPath === undefined ? {} : { endPath }),
      ...(endAnchors === undefined ? {} : { endAnchors }),
      // What the live run needed to reach its end state, plus room for a
      // slower day: the budget a replay waits for the anchors to return.
      ...(endAnchors === undefined ? {} : { endWaitMs: Date.now() - this.startedMs + END_WAIT_MARGIN_MS }),
    });
    if (trace === undefined) return;
    // A trace with no start anchor — no recorded path (a surface without a URL)
    // and no opening navigate — could never replay: `wrong-context` forever.
    // Writing it would be pure store traffic, so it is not written at all.
    if (trace.startPath === undefined && !opensWithNavigate(trace)) return;
    this.cache.staged.push({ keyHash: this.keyHash, trace, stepIndex: this.options.stepIndex });
  }

  /**
   * Awaited so the step does not close — and a later read cannot be served
   * the stale flow — before the eviction has settled. The cache is
   * disposable; a failed eviction is a slower next run only.
   */
  private async evict(): Promise<void> {
    await this.cache.store.delete?.(this.keyHash).catch(() => undefined);
  }

  private repairedAfterEndMismatch(recorder: TraceRecorder): boolean {
    return this.actionsAtEndMismatch !== undefined && recorder.recordedCount > this.actionsAtEndMismatch;
  }

  private missed(reason: TraceReplayMissReason | HandOffReason, totalActions: number): StepCacheInfo {
    return { mode: 'missed', reason, replayedActions: 0, totalActions };
  }
}

/**
 * One settled look at the screen, or undefined when the surface cannot be
 * observed right now — the executor's business, not the cache's. Runtime hard
 * stops (timeout, cancellation) are the step's truth even when they land
 * during cache bookkeeping, and propagate.
 */
async function probeScreen(host: StepCacheHost): Promise<ObservedNodes | undefined> {
  try {
    return await host.observeSettled();
  } catch (cause) {
    if (isRuntimeHardStop(cause)) throw cause;
    return undefined;
  }
}
