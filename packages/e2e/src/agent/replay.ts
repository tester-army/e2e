/**
 * Zero-turn trace replay.
 *
 * Replays one recorded trace through the same action grammar the executor
 * uses — every replayed action runs under the step's deadline, action budget,
 * origin policy, secret authorization, and recording. No model is called.
 *
 * Adaptive, never fatal: any reason the trace cannot finish — a gap, a target
 * that moved, an action the live app rejected — ends the replayed prefix and
 * hands the step to the executor mid-step. Runtime hard stops (budget,
 * timeout, cancellation) rethrow untouched; they are the step's truth, not a
 * divergence.
 */

import { anchorsPresent } from '../cache/anchors.ts';
import { relocateDescriptor, type RelocationResult } from '../cache/relocate.ts';
import type { ActionTrace, RecordedAction, TraceTargetDescriptor, TraceViewport } from '../cache/trace.ts';
import type { SemanticNode, ViewportPoint } from '../engine/surface.ts';
import { sleep } from '../internal/time.ts';
import {
  isRuntimeHardStop,
  type ExecutorActions,
  type ExecutorTarget,
  type ReplayHandOffReason,
} from './executor.ts';

/** Backoff between looks at the screen while it settles. */
const RETRY_DELAYS_MS = [100, 300, 600, 1_000, 3_000] as const;

/** Ceiling on one poll's total wait, inside whatever the deadline allows. */
const RETRY_TIMEOUT_MS = 15_000;

/** The nodes of one observation, keyed by their per-observation ids. */
export type ObservedNodes = ReadonlyMap<string, SemanticNode>;

/** One capture's location and viewport, with nodes only when semantic evidence is available. */
export type ObservedScreen = {
  readonly viewport: TraceViewport;
  readonly path?: string;
} & (
  | { readonly kind: 'semantic'; readonly nodes: ObservedNodes }
  | { readonly kind: 'pixels' }
);

/** The only capture variant that can establish trace targets or anchors. */
type SemanticScreen = Extract<ObservedScreen, { kind: 'semantic' }>;

/** What the replay engine needs from the dispatch, and nothing more. */
export interface ReplayHost {
  /** False once any capture in this step loses semantic evidence. */
  readonly traceEligible: boolean;
  /** One raw capture, for the looks between retries. */
  observe(): Promise<ObservedScreen>;
  /**
   * One settled capture — the dispatch's own, so a replayed action never
   * lands on a screen still reacting to the previous one, and the pacing can
   * never drift from the executor-facing observe.
   */
  observeSettled(): Promise<ObservedScreen>;
  /** The step's policed action grammar; targets are fresh-observation ids. */
  readonly actions: ExecutorActions;
  readonly signal: AbortSignal;
  remainingMs(): number;
  readonly redact: (text: string) => string;
}

export interface ReplayOutcome {
  /** True when every recorded action executed; the step self-finalizes. */
  readonly completed: boolean;
  readonly executed: number;
  readonly total: number;
  /** Prose summaries of the executed actions, for the hand-off notice. */
  readonly summaries: readonly string[];
  /** Present exactly when `completed` is false. */
  readonly stopReason?: ReplayHandOffReason;
  /** The action whose commit state is unknown, on `action-uncertain` only. */
  readonly uncertainAction?: string;
}

/**
 * One recorded action bound to its grammar call. Built where the action's
 * variant is narrowed, so execution needs no casts and no non-null
 * assertions: a targeted plan cannot exist without its descriptor.
 */
type PlannedCall =
  | { readonly kind: 'gap' }
  | {
      readonly kind: 'targeted';
      readonly descriptor: TraceTargetDescriptor;
      readonly invoke: (target: ExecutorTarget) => Promise<void>;
    }
  | { readonly kind: 'free'; readonly invoke: () => Promise<void> }
  /** A bare point, replayed as given once the viewport is the recorded size. */
  | { readonly kind: 'point'; readonly point: ViewportPoint; readonly viewport: TraceViewport }
  /** A bare point placed inside a re-found node's live box. */
  | { readonly kind: 'within'; readonly descriptor: TraceTargetDescriptor; readonly fx: number; readonly fy: number };

function planCall(action: RecordedAction, actions: ExecutorActions): PlannedCall {
  switch (action.name) {
    case 'tool':
      return { kind: 'gap' };
    case 'tap':
      return { kind: 'targeted', descriptor: action.target, invoke: (t) => actions.tap(t) };
    case 'type':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.type(t, action.value),
      };
    case 'typeSecret':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.typeSecret(t, action.secret),
      };
    case 'press':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.press(t, action.key),
      };
    case 'select':
      return {
        kind: 'targeted',
        descriptor: action.target,
        invoke: (t) => actions.select(t, action.value),
      };
    case 'scroll':
      return action.target === undefined
        ? { kind: 'free', invoke: () => actions.scroll(action.direction) }
        : {
            kind: 'targeted',
            descriptor: action.target,
            invoke: (t) => actions.scroll(action.direction, t),
          };
    case 'navigate':
      return { kind: 'free', invoke: () => actions.navigate(action.url) };
    case 'typeText':
      return { kind: 'free', invoke: () => actions.typeText(action.value, { replace: action.replace }) };
    case 'pressKey':
      return { kind: 'free', invoke: () => actions.pressKey(action.key) };
    case 'dismissKeyboard':
      return { kind: 'free', invoke: () => actions.dismissKeyboard() };
    case 'tapAt':
      return action.within === undefined
        ? { kind: 'point', point: action.point, viewport: action.viewport }
        : { kind: 'within', descriptor: action.within.target, fx: action.within.fx, fy: action.within.fy };
  }
}

/** Replays one trace until it completes or diverges. */
export async function replayTrace(
  host: ReplayHost,
  trace: ActionTrace,
): Promise<ReplayOutcome> {
  const summaries: string[] = [];
  const total = trace.actions.length;
  const stop = (stopReason: ReplayHandOffReason): ReplayOutcome => ({
    completed: false,
    executed: summaries.length,
    total,
    summaries,
    stopReason,
  });

  for (const action of trace.actions) {
    if (!host.traceEligible) return stop('action-failed');
    const planned = planCall(action, host.actions);
    if (planned.kind === 'gap') return stop('gap');
    try {
      switch (planned.kind) {
        case 'targeted': {
          const relocated = await relocate(host, planned.descriptor);
          if (relocated.kind === 'failed') return stop(relocated.failure);
          await planned.invoke({ id: relocated.id });
          break;
        }
        case 'free':
          await planned.invoke();
          break;
        case 'point': {
          const screen = await host.observeSettled();
          if (screen.kind === 'pixels') return stop('action-failed');
          const { viewport } = screen;
          if (viewport.width !== planned.viewport.width || viewport.height !== planned.viewport.height) {
            return stop('viewport-changed');
          }
          await host.actions.tapAt(planned.point);
          break;
        }
        case 'within': {
          const relocated = await relocate(host, planned.descriptor);
          if (relocated.kind === 'failed') return stop(relocated.failure);
          const box = relocated.node.rect;
          // A re-found node without a box gives the point nowhere to land.
          if (box === undefined || box.width <= 0 || box.height <= 0) return stop('target-not-found');
          await host.actions.tapAt({ x: box.x + planned.fx * box.width, y: box.y + planned.fy * box.height });
          break;
        }
      }
    } catch (cause) {
      if (isReplayFatal(cause, host.signal)) throw cause;
      if (isUncertainCommit(cause)) {
        // Input may have reached the app (spec 09): the hand-off must name
        // the uncertain action so the executor verifies before re-acting —
        // the runner never repeats an unknown-commit operation itself.
        return { ...stop('action-uncertain'), uncertainAction: action.summary };
      }
      return stop('action-failed');
    }
    summaries.push(action.summary);
  }
  return { completed: true, executed: summaries.length, total, summaries };
}

/**
 * Verifies a trace's recorded end anchors against the live screen: every
 * anchor must be present again (`anchors.ts`, every recorded field equal) or
 * the replay must not pass on its own. Waits on the same settling backoff
 * relocation uses, because the recording run's final look came seconds of
 * model latency after its last action and a replay's comes right away: a
 * save still in flight is a wait, not a divergence. A surface that cannot be
 * observed at all is a mismatch too — the executor gets the step and judges
 * the live state; only runtime hard stops propagate.
 */
export async function verifyAnchors(
  host: ReplayHost,
  anchors: readonly TraceTargetDescriptor[],
  options: { readonly waitMs?: number; readonly initial?: SemanticScreen } = {},
): Promise<boolean> {
  if (anchors.length === 0) return true;
  const startedMs = Date.now();
  try {
    const present = await pollSettled(host, ({ nodes }) =>
      anchorsPresent(anchors, nodes, host) ? true : undefined,
      options.initial,
    );
    if (present === true) return true;
    // The settling backoff covers a slow re-render; the recorded run may have
    // waited far longer than that for its effect — a report that takes half a
    // minute — and so does the replay, up to what the recording needed, while
    // the step clock leaves room for a hand-off to act.
    const deadline = startedMs + Math.min(options.waitMs ?? 0, Math.max(0, host.remainingMs() - END_WAIT_RESERVE_MS));
    while (Date.now() < deadline && !host.signal.aborted) {
      await sleep(Math.min(END_WAIT_POLL_MS, deadline - Date.now()), host.signal);
      const screen = await host.observe();
      if (screen.kind === 'pixels' || !host.traceEligible) return false;
      if (anchorsPresent(anchors, screen.nodes, host)) return true;
    }
    return false;
  } catch (cause) {
    if (isReplayFatal(cause, host.signal)) throw cause;
    return false;
  }
}

/** Poll cadence while a replay waits for the recorded end state beyond the settling backoff. */
const END_WAIT_POLL_MS = 1_000;
/** Step clock kept back from that wait, so a hand-off still has room to act. */
const END_WAIT_RESERVE_MS = 20_000;

/**
 * Relocates one descriptor against the settling screen. A missing target is
 * worth another look. So is ambiguity for a descriptor that recorded its
 * position among twins: a form still rendering shows fewer of them than the
 * recording counted, and the count catches up. Ambiguity for a descriptor
 * without a position never retries — two matching nodes will not become one
 * by waiting, and acting on either would be a guess.
 */
async function relocate(
  host: ReplayHost,
  descriptor: TraceTargetDescriptor,
): Promise<Relocated> {
  const options = { redact: host.redact };
  let last: Relocated = { kind: 'failed', failure: 'target-not-found' };
  const settled = await pollSettled(host, ({ nodes }): Relocated | undefined => {
    const result = relocateDescriptor(descriptor, nodes, options);
    if (result.kind === 'failed') {
      last = result;
      return result.failure === 'target-not-found' || descriptor.position !== undefined ? undefined : result;
    }
    const node = nodes.get(result.id);
    return node === undefined ? undefined : { kind: 'found', id: result.id, node };
  });
  return settled ?? last;
}

/** A relocation with the node it found, for a replay that needs its box. */
type Relocated =
  | { readonly kind: 'found'; readonly id: string; readonly node: SemanticNode }
  | Extract<RelocationResult, { kind: 'failed' }>;

/**
 * Probes a settled observation, then re-probes fresh raw captures on a fixed
 * backoff until the probe answers or the wait runs out: a screen
 * mid-transition gets a few looks before replay gives the step up. The first
 * look settles because replay executes recorded actions far faster than the
 * run that recorded them; without that wait an action can land while the app
 * is still reacting to the previous one — a form mid-clear, a list mid-update
 * — and commit something the recorded run never did.
 */
async function pollSettled<T>(
  host: ReplayHost,
  probe: (screen: SemanticScreen) => T | undefined,
  initial?: SemanticScreen,
): Promise<T | undefined> {
  const startedMs = Date.now();
  let screen = initial ?? await host.observeSettled();
  for (let attempt = 0; ; attempt += 1) {
    if (screen.kind === 'pixels' || !host.traceEligible) return undefined;
    const answer = probe(screen);
    if (answer !== undefined) return answer;
    const delay = RETRY_DELAYS_MS[attempt];
    if (
      delay === undefined ||
      Date.now() - startedMs + delay > RETRY_TIMEOUT_MS ||
      host.remainingMs() <= delay
    ) {
      return undefined;
    }
    await sleep(delay, host.signal);
    screen = await host.observe();
  }
}

/** True when any error in the cause chain reports an unknown commit state. */
function isUncertainCommit(cause: unknown): boolean {
  for (let error = cause, depth = 0; depth < 8; depth += 1) {
    if (typeof error !== 'object' || error === null) return false;
    if ((error as { code?: unknown }).code === 'ACTION_MAY_HAVE_COMMITTED') return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True for errors a replay must surface rather than absorb as divergence:
 * runtime hard stops and cancellation are the step's own accounting.
 */
function isReplayFatal(cause: unknown, signal: AbortSignal): boolean {
  return signal.aborted || isRuntimeHardStop(cause);
}
