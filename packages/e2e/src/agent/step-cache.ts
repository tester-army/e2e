/**
 * One step's trace-cache session: key
 * derivation, the replay attempt, live recording, and the stage-or-evict
 * decision once the step has settled — everything cache-shaped about one
 * dispatched act step, kept beside the dispatch rather than threaded through
 * it. The dispatch owns budgets, the grammar, and the verdict; this class owns
 * nothing but the cache.
 *
 * In read-write mode, settled captures before and after the step provide the
 * baseline and end anchors. Read-only mode needs only a raw starting capture
 * for the route precondition. The initial capture can also serve the executor
 * when replay performed no action.
 */

import { anchorsPresent, describeAnchors } from '../cache/anchors.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import { decideTraceReplay, opensWithNavigate, type TraceReplayMissReason } from '../cache/decide.ts';
import { compareRoutes, routeOf } from '../cache/route.ts';
import { instructionDigest } from '../cache/identity.ts';
import { TraceRecorder } from '../cache/recorder.ts';
import { expandTrace, templateParams, templateTrace, type ParamTemplate } from '../cache/template.ts';
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
  type ObservedScreen,
  type ReplayHost,
  type ReplayOutcome,
  type SemanticScreen,
} from './replay.ts';

/**
 * The replay host plus the step's live progress. Each capture carries its
 * location and evidence kind, so path checks need no separate observation.
 */
export interface StepCacheHost extends ReplayHost {
  /**
   * Tells the step's live progress the cache has the step (`true`) or has
   * handed it to the model (`false`), so a reporter can show the cache at
   * work instead of a model turn.
   */
  replaying(active: boolean): void;
}

/** What the session needs from the dispatch beyond the host itself. */
export interface StepCacheOptions {
  readonly cache: AgentCacheContext;
  readonly instruction: string;
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
  /** The `unique()` values in the params: slots in the key and the recording, filled from each call. */
  readonly templates: readonly ParamTemplate[];
  readonly executor: { readonly name: string; readonly version?: string };
  readonly redact: (text: string) => string;
  readonly maxActions: number;
  /** Timeline index of the step being dispatched. */
  readonly stepIndex: number;
}

/** How the step settled, as the write-side decision sees it. */
export type StepOutcome = 'passed' | 'failed' | 'cancelled';

type HandOffReason = ReplayedPrefix['stopReason'];

/** One store read: a validated entry, or why none was read. */
type EntryRead =
  | { readonly status: 'hit'; readonly entry: TraceEntry }
  | { readonly status: 'miss'; readonly reason: 'retry' | 'no-entry' | 'invalid-entry' };

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
   * The trace the cache finished the step with on its own: every recorded
   * action replayed and the recorded end state held. Such a step stages the
   * entry as replayed rather than re-recording it, so a confirmed attempt
   * writes nothing and an unconfirmed one still evicts.
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
    // The key digests the params as the recording spells them, a placeholder
    // where each `unique()` value was, so every run's value finds one entry.
    this.keyHash = options.cache.claimKeyHash('act', options.instruction, templateParams(options.params, options.templates));
    if (options.cache.mode === 'read-write') {
      this.recorder = new TraceRecorder({
        redact: options.redact,
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
   * Opens the step: reads the cache entry, captures the write-side
   * preconditions — the start path and, when this step may write, the
   * baseline screen — then attempts a zero-turn replay of a hit. Returns the
   * self-finalized verdict on a full replay whose postcondition holds;
   * undefined dispatches the executor — after a miss from the top, after a
   * divergence mid-step with `replayedPrefix` set. Every failure to replay is
   * a miss, never an error; only runtime hard stops propagate.
   */
  async begin(): Promise<StepVerdict | undefined> {
    this.startedMs = Date.now();
    // A retry records like any step but never replays; the report says so
    // instead of looking like a step that ran with caching off.
    const read: EntryRead = this.cache.replayEligible
      ? await this.readEntry()
      : { status: 'miss', reason: 'retry' };
    if (read.status === 'miss') {
      await this.captureStart(this.recorder !== undefined);
      this.info = this.missed(read.reason, 0);
      return undefined;
    }
    // With an entry in hand the step is the cache's from its first moment: the
    // baseline probe doubles as the replay's start-path check, and a step the
    // replay finishes stays the cache's through its verdict and the re-stage,
    // so a reporter never shows a model turn that is not coming. Only a replay
    // that cannot finish the step hands it to the model.
    this.host.replaying(true);
    const verdict = await this.replayEntry(read.entry);
    if (verdict === undefined) this.host.replaying(false);
    return verdict;
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
   * - passed after the cache replayed the whole step: stage the entry as
   *   replayed. Confirmed, it is left as it stands; re-writing it would change
   *   only its `createdAt`, dirtying a committed cache directory on every
   *   run. Unconfirmed, it is evicted like a new recording would be. A
   *   descriptor that drifts far enough to matter fails its relocation, and
   *   the hand-off that follows re-records.
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
        else if (this.replayed !== undefined) {
          this.cache.staged.push({ keyHash: this.keyHash, trace: this.replayed, stepIndex: this.options.stepIndex, replayed: true });
        } else await this.stage(recorder, verdictSummary);
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
    if (entry === undefined) return { status: 'miss', reason: 'invalid-entry' };
    // The stored recording has a slot for each `unique()` value; this call's
    // values fill it. A slot this call cannot fill is an entry recorded for
    // another shape, which the key should have kept apart.
    const payload = expandTrace(entry.payload, this.options.templates);
    if (payload === undefined) return { status: 'miss', reason: 'invalid-entry' };
    return { status: 'hit', entry: { ...entry, payload } };
  }

  /**
   * The write-side preconditions, captured before any action: the start path,
   * doubling as the replay decision's current path, and the baseline screen
   * when this step may write. Settled when the baseline is kept or a replay
   * is about to act on it; a raw look otherwise serves the path alone.
   */
  private async captureStart(settle: boolean): Promise<ObservedScreen | undefined> {
    const observation = await probeScreen(this.host, settle);
    this.startPath = observation?.path;
    if (this.recorder !== undefined && observation?.kind === 'semantic') this.startNodes = observation.nodes;
    return observation;
  }

  /**
   * Replays one hit: decides it against the start path, runs the recorded
   * actions, then checks the postcondition. Actions that all ran prove the
   * clicks happened; only the postcondition proves the save took. A flow whose
   * destination changed, or whose effect is not on screen again, hands off
   * like any other divergence. The start capture is settled whichever mode
   * the cache is in, and the replay's first look reads it rather than
   * capturing the same screen again.
   */
  private async replayEntry(entry: TraceEntry): Promise<StepVerdict | undefined> {
    const start = await this.captureStart(true);
    const trace = entry.payload;
    if (!this.host.traceEligible) {
      this.info = this.missed('truncated', trace.actions.length);
      return undefined;
    }
    const decision = decideTraceReplay(entry, this.startPath);
    if (decision.action === 'miss') {
      this.info = this.missed(decision.reason, trace.actions.length);
      return undefined;
    }
    const outcome = await replayTrace(this.host, trace, start?.kind === 'semantic' ? { initial: start } : {});
    this.consumedReplay = true;
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
   * The trace's postcondition against the live screen: the recorded end
   * route (when the live location is known) and every recorded end anchor
   * present again. A route the path leaves undecided is the recorded screen
   * only if the anchors are already on it, which then needs no second look.
   */
  private async endStateMatches(trace: ActionTrace): Promise<boolean> {
    if (!this.host.traceEligible) return false;
    const arrived = await this.endScreen(trace);
    if (arrived === undefined) return false;
    if (arrived.anchorsSeen) return true;
    return (await verifyAnchors(this.host, trace.endAnchors ?? [], {
      initial: arrived.screen,
      ...(trace.endWaitMs === undefined ? {} : { waitMs: trace.endWaitMs }),
    })) && this.host.traceEligible;
  }

  /**
   * Captures the semantic end state once its route matches the recording,
   * polling while a navigation the last action started commits. Reports
   * whether the anchors were what settled the route, so the caller does not
   * verify them again. A route still undecided when the poll runs out is
   * handed on with the anchors unseen: the caller's anchor wait, sized by
   * the recording, is the one that decides it, as for a route that matched.
   */
  private async endScreen(
    trace: ActionTrace,
  ): Promise<{ readonly screen: SemanticScreen; readonly anchorsSeen: boolean } | undefined> {
    const startedMs = Date.now();
    const recorded = trace.endPath === undefined ? undefined : routeOf(trace.endPath);
    const anchors = trace.endAnchors ?? [];
    for (let attempt = 0; ; attempt += 1) {
      const observation = await probeScreen(this.host, false);
      if (observation?.kind !== 'semantic' || !this.host.traceEligible) return undefined;
      if (recorded === undefined || observation.path === undefined) return { screen: observation, anchorsSeen: false };
      const verdict = compareRoutes(recorded, routeOf(observation.path));
      if (verdict === 'same') return { screen: observation, anchorsSeen: false };
      // A path the runner cannot recognize as the recorded route is the
      // recorded screen only if the recorded effect is visibly on it; with
      // no anchors recorded there is nothing to see, and it is another screen.
      const undecided = verdict === 'undecided' && anchors.length > 0;
      if (undecided && anchorsPresent(anchors, observation.nodes, { redact: this.options.redact })) {
        return { screen: observation, anchorsSeen: true };
      }
      const delay = END_PATH_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        Date.now() - startedMs + delay > END_PATH_TIMEOUT_MS ||
        this.host.remainingMs() <= delay ||
        this.host.signal.aborted
      ) {
        return undecided ? { screen: observation, anchorsSeen: false } : undefined;
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
    return { status: 'passed', summary: replaySummary(outcome.executed, trace.summary) };
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
   * step the executor finished after a hand-off re-stages the entry with
   * fresh descriptors and anchors, which is how staleness self-heals; a step
   * the cache replayed whole never reaches here.
   *
   * The end path and a fresh settled observation are the trace's
   * postcondition — the state the step passed in. The delta between the
   * baseline and the passing observation becomes the end anchors. When the
   * step moved to another pathname the whole new screen is the delta, and its
   * first stable anchors back the path check, which matches a created
   * record's page up to the id the app minted for it. A postcondition that
   * cannot be captured stages nothing: a trace without its check would
   * replay on mechanics alone.
   */
  private async stage(recorder: TraceRecorder, verdictSummary: string | undefined): Promise<void> {
    if (!this.host.traceEligible || this.startNodes === undefined || recorder.recordedCount === 0) return;
    const observation = await probeScreen(this.host);
    if (!this.host.traceEligible || observation?.kind !== 'semantic') return;
    const { nodes: endNodes, path: endPath } = observation;
    const endAnchors = describeAnchors(this.startNodes, endNodes, this.options);
    const trace = recorder.finalize({
      executor: this.options.executor,
      recordedFor: {
        testId: this.cache.identity.testId,
        targetId: this.cache.identity.targetId,
        instructionDigest: instructionDigest(this.options.instruction),
      },
      summary: verdictSummary ?? 'step passed',
      ...(this.startPath === undefined ? {} : { startPath: this.startPath }),
      ...(endPath === undefined ? {} : { endPath }),
      endAnchors,
      // How long the app took to show its end state after the last action,
      // plus room for a slower day: the budget a replay waits for the anchors
      // to return. Measured from the last action, not the step's start: the
      // model's thinking time before that action is no reason for a replay,
      // which does not think, to wait.
      endWaitMs: Date.now() - (recorder.lastActionAtMs ?? this.startedMs) + END_WAIT_MARGIN_MS,
    });
    if (trace === undefined) return;
    // A trace with no start anchor — no recorded path (a surface without a URL)
    // and no opening navigate — could never replay: `wrong-context` forever.
    // Writing it would be pure store traffic, so it is not written at all.
    if (trace.startPath === undefined && !opensWithNavigate(trace)) return;
    // Stored with a slot where each `unique()` value appeared, so the next
    // run's values — a fresh timestamped name — replay the same flow. A
    // recording that cannot be templated safely is not written at all.
    const templated = templateTrace(trace, this.options.templates);
    if (templated === undefined) return;
    this.cache.staged.push({ keyHash: this.keyHash, trace: templated, stepIndex: this.options.stepIndex });
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
 * One cache capture, or undefined when the surface cannot be
 * observed right now — the executor's business, not the cache's. Runtime hard
 * stops (timeout, cancellation) are the step's truth even when they land
 * during cache bookkeeping, and propagate.
 */
async function probeScreen(host: StepCacheHost, settle = true): Promise<ObservedScreen | undefined> {
  try {
    return await (settle ? host.observeSettled() : host.observe());
  } catch (cause) {
    if (isRuntimeHardStop(cause)) throw cause;
    return undefined;
  }
}

const REPLAY_NOTICE_START = 'replayed ';
const RECORDED_VERDICT_SEPARATOR = '; recorded verdict: ';

/** The verdict summary of a step the cache replayed whole: the notice, then the recorded verdict. */
function replaySummary(executed: number, recorded: string): string {
  return `${REPLAY_NOTICE_START}${String(executed)} recorded action(s) zero-turn from the trace cache${RECORDED_VERDICT_SEPARATOR}${recorded}`;
}

/**
 * The recorded verdict alone, for the ledger later steps read: how the step
 * was served is the report's business, not context a model should reason
 * about, and the notice would spend handoff bytes on every replayed step.
 * Built from the two constants `replaySummary` writes with, so the two cannot
 * drift apart; a summary not written by it is returned as is.
 */
export function recordedVerdictOf(summary: string): string {
  if (!summary.startsWith(REPLAY_NOTICE_START)) return summary;
  const at = summary.indexOf(RECORDED_VERDICT_SEPARATOR);
  return at === -1 ? summary : summary.slice(at + RECORDED_VERDICT_SEPARATOR.length);
}
