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

import { deltaEvidenced, deltaHolds, describeDelta } from '../cache/anchors.ts';
import type { AgentCacheContext, ClaimedKey } from '../cache/context.ts';
import { decideTraceReplay, opensWithNavigate, type TraceReplayMissReason } from '../cache/decide.ts';
import { sameRoute } from '../cache/route.ts';
import type { CacheAgentIdentity } from '../cache/identity.ts';
import { recordedProvenance, TraceRecorder } from '../cache/recorder.ts';
import { expandTrace, templateParams, templatesCollide, templateTrace, type ParamTemplate } from '../cache/template.ts';
import { readTraceEntry, type ActionTrace, type DerivedReason, type TraceEntry, type TraceTargetDescriptor } from '../cache/trace.ts';
import { sleep } from '../internal/time.ts';
import type { StepCacheInfo } from '../run/steps.ts';
import type { JsonValue } from '../types.ts';
import type { RecordableAction } from './actions.ts';
import { AgentError, isAgentError, isModelUnreachable } from './error.ts';
import { isRuntimeHardStop, type ReplayedPrefix, type StepVerdict } from './executor.ts';
import {
  replayTrace,
  verifyEndState,
  type ObservedNodes,
  type ObservedScreen,
  type ReplayHost,
  type ReplayOutcome,
  type SemanticScreen,
} from './replay.ts';
import { redactNodesAgain, type NodeRedaction } from './observation.ts';
import type { SettleMode } from './settle-policy.ts';

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
  /** The agent the step runs with, part of the key (`cache/identity.ts`). */
  readonly agent: CacheAgentIdentity;
  readonly redact: (text: string) => string;
  /** `redact` for a field cut at its observed limit (`SecretLedger.redactCut`). */
  readonly redactCut: (text: string) => string;
  readonly maxActions: number;
  /** Timeline index of the step being dispatched. */
  readonly stepIndex: number;
}

/**
 * How the step settled, as the write-side decision sees it. `no-verdict` is a
 * step that ended without anything judging the app: it was cancelled, or no
 * model answered (`isModelUnreachable`). Neither says the recorded flow is
 * wrong, so neither implicates its entry.
 */
export type StepOutcome = 'passed' | 'failed' | 'no-verdict';

/** The outcome of a step that threw `cause`. */
export function failedStepOutcome(cause: unknown): Exclude<StepOutcome, 'passed'> {
  if (isModelUnreachable(cause)) return 'no-verdict';
  return isAgentError(cause) && cause.code === 'CANCELLED' ? 'no-verdict' : 'failed';
}

type HandOffReason = ReplayedPrefix['stopReason'];

/** One store read: a validated entry, or why none was read. */
type EntryRead =
  | { readonly status: 'hit'; readonly entry: TraceEntry }
  | {
      readonly status: 'miss';
      readonly reason: 'retry' | 'no-entry' | 'invalid-entry';
      /** The store's read rejected: nothing says a recording exists, so `cache.strict` runs the step live. */
      readonly unavailable?: true;
    };

/**
 * What the start capture is for, which decides how far it settles. The path
 * alone reads the screen as it is. A baseline (the end anchors are the delta
 * from it) and a replay start (the first relocation reads it) must be a
 * settled screen. A hit the decision then refuses has paid that settle for
 * nothing in read-only mode, a rarer case than the replay it saves a
 * capture on.
 */
type StartPurpose = 'path-only' | 'baseline' | 'replay-start';

/**
 * The reasons a recording that exists no longer replays: the app or the
 * entry changed under it. The others describe the step (a value read off
 * the screen, a flow too long to record), the attempt (a retry), or the
 * absence of a recording, and run live under `cache.strict` too.
 */
const STALE_REASONS: ReadonlySet<StepCacheInfo['reason']> = new Set<StepCacheInfo['reason']>([
  'invalid-entry',
  'wrong-context',
  'target-not-found',
  'target-ambiguous',
  'viewport-changed',
  'action-failed',
  'action-uncertain',
  'end-mismatch',
]);

/** Margin added to a recorded step's duration when replay waits for its end state. */
const END_WAIT_MARGIN_MS = 10_000;
/**
 * How long a replay waits for a recorded destination path to be the current
 * one. The replayed tap that starts a navigation returns before the new
 * document commits. Reading the path once, right after the
 * tap, hands every navigation off as an end-mismatch; polling with the
 * settling backoff lets the destination arrive. Bounded like anchor polling.
 */
const END_PATH_DELAYS_MS = [100, 300, 600, 1_000, 3_000] as const;
const END_PATH_TIMEOUT_MS = 15_000;

export class StepTraceSession {
  private readonly host: StepCacheHost;
  private readonly cache: AgentCacheContext;
  private readonly keyHash: string;
  /** The claimed key and the step it names, which an entry records as its provenance. */
  private readonly claim: ClaimedKey;
  private readonly recorder: TraceRecorder | undefined;
  private readonly options: StepCacheOptions;
  private readonly redaction: NodeRedaction;
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
   * True once the cache finished the step on its own: every recorded action
   * replayed and the recorded end state held. Such a step stages its entry
   * to keep rather than a recording to write, so a confirmed attempt writes
   * nothing and an unconfirmed one still evicts.
   */
  private replayedWhole = false;
  /** True once a cached entry's actions were run this step, fully or partly. */
  private consumedReplay = false;
  /** True once the store returned an entry for this step, whether or not it replayed. */
  private readEntryHit = false;
  /** True once `cache.strict` failed the step on its recording, which is then kept for review rather than evicted. */
  private failedStale = false;
  /** Grammar actions recorded so far when an end-mismatch hand-off happened. */
  private actionsAtEndMismatch: number | undefined;

  constructor(host: StepCacheHost, options: StepCacheOptions) {
    this.host = host;
    this.options = options;
    this.redaction = { redact: options.redact, redactCut: options.redactCut };
    this.cache = options.cache;
    // The key digests the params as the recording spells them, a placeholder
    // where each `unique()` value was, so every run's value finds one entry.
    this.claim = options.cache.claimKey('act', options.instruction, templateParams(options.params, options.templates), options.agent);
    this.keyHash = this.claim.keyHash;
    if (options.cache.mode === 'read-write') {
      this.recorder = new TraceRecorder({
        ...this.redaction,
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

  /** Records a fill whose value was this run's data as a replay-ending gap, with the rule that said so. */
  recordDerivedGap(reason: DerivedReason): void {
    this.recorder?.recordDerivedGap(reason);
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
      await this.captureStart(this.recorder === undefined ? 'path-only' : 'baseline');
      this.info = this.missed(read.reason, 0);
      if (read.unavailable !== true) this.failIfStale();
      if (read.reason === 'no-entry') await this.failIfRekeyed();
      return undefined;
    }
    // With an entry in hand the step is the cache's from its first moment: the
    // baseline probe doubles as the replay's start-path check, and a step the
    // replay finishes stays the cache's through its verdict and the re-stage,
    // so a reporter never shows a model turn that is not coming. Only a replay
    // that cannot finish the step hands it to the model.
    this.readEntryHit = true;
    this.host.replaying(true);
    const verdict = await this.replayEntry(read.entry);
    if (verdict === undefined) {
      this.host.replaying(false);
      this.failIfStale();
    }
    return verdict;
  }

  /**
   * Under `cache.strict`, ends the step when its recording exists but no
   * longer replays, rather than handing it to the executor: a committed
   * recording that went stale is a change to re-record in review, not a
   * model call to absorb on every run. The report keeps the cache detail.
   */
  private failIfStale(): void {
    const reason = this.info?.reason;
    const { strict } = this.cache;
    if (strict === false || !STALE_REASONS.has(reason)) return;
    this.failedStale = true;
    throw new AgentError(
      'REPLAY_STALE',
      `the recording of this step no longer replays (${reason}), and cache.strict hands no step to the agent; ${strict.advice}`,
    );
  }

  /**
   * Under `cache.strict`, ends a step whose key found no entry while the
   * store holds a recording made for the same step under another key: the
   * runner, the engine, the app, or the agent's context changed since, and
   * the recording no longer replays as surely as one that diverged. A step
   * whose instruction changed is a new step and still runs live, and so is
   * one whose params changed once its entry recorded them.
   */
  private async failIfRekeyed(): Promise<void> {
    const { strict } = this.cache;
    if (strict === false || strict.recordings === undefined) return;
    const previous = await strict.recordings.underAnotherKey(recordedProvenance(this.claim.step, this.options.redact), this.claim.claimed);
    if (previous === undefined) return;
    this.failedStale = true;
    throw new AgentError(
      'REPLAY_STALE',
      `the recording of this step no longer replays: the store holds it under another cache key (${previous}.json), since the runner, the engine, the app, or the agent's context changed after it was recorded, and cache.strict hands no step to the agent; ${strict.advice}`,
    );
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
   * - passed after the cache replayed the whole step: stage the entry to
   *   keep. Confirmed, it is left as it stands; re-writing it would change
   *   only its `createdAt`, dirtying a committed cache directory on every
   *   run. Unconfirmed, it is evicted like a new recording would be. The
   *   trade: a replay that still finds every control refreshes no descriptor,
   *   anchor, or end wait, so drift is repaired only once a relocation fails
   *   and the hand-off that follows re-records.
   * - passed otherwise: stage the recorded trace for attempt-end settlement.
   *   When this pass leaves nothing to stage (it changed nothing a replay
   *   could check) and an entry was read for the step, evict that entry: it
   *   did not serve this pass, and nothing recorded will replace it, so
   *   keeping it would hand every later run off the same way.
   * - failed after consuming a replay: evict. Without this, a diverged replay
   *   whose step then fails stages nothing — and the poisoned entry would
   *   replay its bad prefix on every future first attempt.
   * - no verdict (cancelled, or no model answered): nothing, exactly like an
   *   interrupted attempt. A replay that stopped at a gap and handed off to a
   *   model that never answered proved nothing against the recording, and one
   *   that diverged hands off again next run, where a model that answers
   *   re-records it.
   */
  async conclude(outcome: StepOutcome, verdictSummary: string | undefined): Promise<void> {
    const recorder = this.recorder;
    if (recorder === undefined) return;
    switch (outcome) {
      case 'no-verdict':
        return;
      case 'failed':
        // A stale recording `cache.strict` failed on stays for the next strict
        // run to fail on too, until a lenient run re-records it; evicting it
        // would turn it into a `no-entry` that runs live.
        if (this.consumedReplay && !this.failedStale) await this.evict();
        return;
      case 'passed':
        if (this.repairedAfterEndMismatch(recorder)) await this.evict();
        else if (this.replayedWhole) {
          this.cache.staged.push({ kind: 'keep', keyHash: this.keyHash, stepIndex: this.options.stepIndex });
        } else if (!(await this.stage(recorder, verdictSummary)) && this.readEntryHit) await this.evict();
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
      return { status: 'miss', reason: 'invalid-entry', unavailable: true };
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
   * when this step may write. Settled as far as the capture's purpose asks.
   */
  private async captureStart(purpose: StartPurpose): Promise<ObservedScreen | undefined> {
    const observation = await probeScreen(this.host, purpose === 'path-only' ? 'raw' : 'held-still');
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
    const start = await this.captureStart('replay-start');
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
    // Every screen the replay looks at, in order, from the start: the end
    // check measures the recorded delta from the first of them on the route
    // the replay ends on, so a free action is preceded by a look until one
    // on the recorded end route has been seen.
    const screens: ObservedScreen[] = start === undefined ? [] : [start];
    const onEndRoute = (screen: ObservedScreen | undefined) =>
      screen !== undefined && (trace.endPath === undefined || (screen.path !== undefined && sameRoute(screen.path, trace.endPath)));
    const host = this.host;
    const watched: ReplayHost = {
      get traceEligible() {
        return host.traceEligible;
      },
      observe: async (mode) => {
        const screen = await host.observe(mode);
        screens.push(screen);
        return screen;
      },
      actions: host.actions,
      signal: host.signal,
      remainingMs: () => host.remainingMs(),
    };
    const outcome = await replayTrace(watched, trace, {
      ...(start?.kind === 'semantic' ? { initial: start } : {}),
      looksBeforeFree: () => !onEndRoute(screens.at(-1)),
    });
    this.consumedReplay = true;
    const stopReason: HandOffReason | undefined = outcome.completed
      ? start?.kind === 'semantic' && (await this.endStateMatches(trace, start, screens))
        ? undefined
        : 'end-mismatch'
      : (outcome.stopReason ?? 'action-failed');
    if (stopReason === undefined) return this.selfFinalize(trace, outcome);
    if (outcome.executed === 0) {
      // A prefix that performed nothing is a miss with a name, not a hand-off:
      // the executor starts from the top and owes the notice nothing.
      this.info = this.missed(stopReason, outcome.total, outcome.derived);
      return undefined;
    }
    this.handOff(outcome, stopReason);
    return undefined;
  }

  /**
   * The trace's postcondition against the live screen: the recorded end
   * route when the live location is known, the recorded delta on the
   * screen (`deltaHolds`), and evidence that the replay produced it rather
   * than finding it there (`deltaEvidenced`). The evidence is measured from
   * the first screen the replay saw on the route it ended on (`screens`, in
   * order): the start for a step that stays on one screen, the page a
   * recorded navigate opened before the switch on it was tapped. An outcome
   * already showing there proves nothing, and neither does a recording with
   * no delta at all.
   */
  private async endStateMatches(trace: ActionTrace, start: SemanticScreen, screens: readonly ObservedScreen[]): Promise<boolean> {
    if (!this.host.traceEligible) return false;
    const arrived = await this.endScreen(trace);
    if (arrived === undefined) return false;
    // Both captures may predate a secret the replay resolved; read with the
    // ledger as it is now, an unchanged node is no change.
    const baseline = baselineScreen(screens, arrived.path);
    const baselineNodes = baseline === undefined ? undefined : redactNodesAgain(baseline.nodes, this.redaction);
    if (!deltaEvidenced(trace, baselineNodes, inputTargets(trace))) return false;
    const beforeNodes = baselineNodes ?? redactNodesAgain(start.nodes, this.redaction);
    // Every look the wait takes must still be on the recorded end route: a
    // screen that moved on after the route first matched is another screen.
    const holds = (screen: SemanticScreen) =>
      (trace.endPath === undefined || screen.path === undefined || sameRoute(screen.path, trace.endPath)) &&
      deltaHolds(trace, screen.nodes, beforeNodes);
    return (await verifyEndState(this.host, holds, {
      initial: arrived,
      ...(trace.endWaitMs === undefined ? {} : { waitMs: trace.endWaitMs }),
    })) && this.host.traceEligible;
  }

  /**
   * Captures the semantic end state once its route matches the recording,
   * polling while a navigation the last action started commits. A route
   * that never matches is another screen, whatever it shows: a link that
   * now lands on a page sharing the recorded one's layout is exactly the
   * flow that went wrong.
   */
  private async endScreen(trace: ActionTrace): Promise<SemanticScreen | undefined> {
    const startedMs = Date.now();
    const recorded = trace.endPath;
    for (let attempt = 0; ; attempt += 1) {
      const observation = await probeScreen(this.host, 'raw');
      if (observation?.kind !== 'semantic' || !this.host.traceEligible) return undefined;
      if (recorded === undefined || observation.path === undefined || sameRoute(recorded, observation.path)) return observation;
      const delay = END_PATH_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        Date.now() - startedMs + delay > END_PATH_TIMEOUT_MS ||
        this.host.remainingMs() <= delay ||
        this.host.signal.aborted
      ) {
        return undefined;
      }
      await sleep(delay, this.host.signal);
    }
  }

  private selfFinalize(trace: ActionTrace, outcome: ReplayOutcome): StepVerdict {
    this.replayedWhole = true;
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
      ...(outcome.derived === undefined ? {} : { derived: outcome.derived }),
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
   * baseline and the passing observation becomes the anchors: what appeared
   * and what vanished. When the step moved to another pathname the whole new
   * screen is the delta, and its first stable anchors back the path check,
   * which matches a created record's page up to the id the app minted for
   * it. A postcondition that cannot be captured stages nothing, and neither
   * does a step that changed nothing a replay could check, no node and no
   * route: a trace without its check would replay on mechanics alone.
   */
  private async stage(recorder: TraceRecorder, verdictSummary: string | undefined): Promise<boolean> {
    if (!this.host.traceEligible || this.startNodes === undefined || recorder.recordedCount === 0) return false;
    const observation = await probeScreen(this.host, 'held-still');
    if (!this.host.traceEligible || observation?.kind !== 'semantic') return false;
    const { nodes: endNodes, path: endPath } = observation;
    // The start capture may predate a secret this step resolved; read with
    // the ledger as it is now, an unchanged node is no delta.
    const startNodes = redactNodesAgain(this.startNodes, this.redaction);
    const routeMoved = this.startPath !== undefined && endPath !== undefined && !sameRoute(this.startPath, endPath);
    const delta = describeDelta(startNodes, endNodes, routeMoved);
    if (delta.appeared.length === 0 && delta.gone.length === 0 && !routeMoved) return false;
    const trace = recorder.finalize({
      executor: this.options.executor,
      recordedFor: this.claim.step,
      summary: verdictSummary ?? 'step passed',
      ...(this.startPath === undefined ? {} : { startPath: this.startPath }),
      ...(endPath === undefined ? {} : { endPath }),
      endAnchors: delta.appeared,
      goneAnchors: delta.gone,
      // How long the app took to show its end state after the last action,
      // plus room for a slower day: the budget a replay waits for the anchors
      // to return. Measured from the last action, not the step's start: the
      // model's thinking time before that action is no reason for a replay,
      // which does not think, to wait.
      endWaitMs: Date.now() - (recorder.lastActionAtMs ?? this.startedMs) + END_WAIT_MARGIN_MS,
    });
    if (trace === undefined) return false;
    // A trace with no start anchor — no recorded path (a surface without a URL)
    // and no opening navigate — could never replay: `wrong-context` forever.
    // Writing it would be pure store traffic, so it is not written at all.
    if (trace.startPath === undefined && !opensWithNavigate(trace)) return false;
    // Stored with a slot where each `unique()` value appeared, so the next
    // run's values — a fresh timestamped name — replay the same flow. A
    // recording that cannot be templated safely is not written at all; when
    // the reason is the params themselves, the report says so.
    if (templatesCollide(this.options.params, this.options.templates)) {
      if (this.info !== undefined) this.info = { ...this.info, notRecorded: 'param-collision' };
      return false;
    }
    const templated = templateTrace(trace, this.options.templates);
    if (templated === undefined) return false;
    this.cache.staged.push({ kind: 'write', keyHash: this.keyHash, trace: templated, stepIndex: this.options.stepIndex });
    return true;
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

  private missed(reason: TraceReplayMissReason | HandOffReason, totalActions: number, derived?: DerivedReason): StepCacheInfo {
    return {
      mode: 'missed',
      reason,
      ...(derived === undefined ? {} : { derived }),
      replayedActions: 0,
      totalActions,
    };
  }
}

/** The controls a trace's input actions set a value or a state on: their changed anchors echo the input. */
function inputTargets(trace: ActionTrace): TraceTargetDescriptor[] {
  return trace.actions.flatMap((action) => ('target' in action && action.target !== undefined ? [action.target] : []));
}

/**
 * The first semantic screen of the replay's last stretch on the route it
 * ended on (`endPath`), or undefined when its last screen before the end
 * was on another route, so the last action moved it. A screen or an end
 * without a location counts as on the route: there is nothing to compare.
 */
function baselineScreen(screens: readonly ObservedScreen[], endPath: string | undefined): SemanticScreen | undefined {
  let baseline: SemanticScreen | undefined;
  for (const screen of screens) {
    if (endPath !== undefined && screen.path !== undefined && !sameRoute(screen.path, endPath)) baseline = undefined;
    else if (screen.kind === 'semantic') baseline ??= screen;
  }
  return baseline;
}

/**
 * One cache capture, settled as far as `mode` asks, or undefined when the
 * surface cannot be observed right now, which is the executor's business,
 * not the cache's. Runtime hard stops (timeout, cancellation) are the step's
 * truth even when they land during cache bookkeeping, and propagate.
 */
async function probeScreen(host: StepCacheHost, mode: SettleMode): Promise<ObservedScreen | undefined> {
  try {
    return await host.observe(mode);
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
