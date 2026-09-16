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
import { describeNodes, descriptorTiers, fieldsEqual, relocateDescriptor, type DescriptorField, type RelocationFailure, type RelocationResult } from '../cache/relocate.ts';
import type { ActionTrace, RecordedAction, TraceTargetDescriptor, TraceViewport } from '../cache/trace.ts';
import type { SemanticNode, ViewportPoint } from '../engine/surface.ts';
import { sleep } from '../internal/time.ts';
import type { ScrollDirection } from '../types.ts';
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
      /** Repeats of one folded action, with a settled look between them as the live loop took. */
      readonly times?: number;
    }
  | { readonly kind: 'free'; readonly invoke: () => Promise<void>; readonly times?: number }
  /**
   * A scroll, folded from its repeats. The list is re-found before every
   * repeat, because a device renumbers its tree on each look and names a
   * scroll view after its first visible row. A list that filled the screen
   * when recorded (`spans`) and cannot be re-found scrolls as the viewport,
   * which is what scrolling the main list does; a smaller region hands off.
   */
  | {
      readonly kind: 'scroll';
      readonly direction: ScrollDirection;
      readonly descriptor?: TraceTargetDescriptor;
      readonly spans?: number;
      readonly times: number;
    }
  /** A bare point, replayed as given once the viewport is the recorded size. */
  | { readonly kind: 'point'; readonly point: ViewportPoint; readonly viewport: TraceViewport }
  /** A bare point placed inside a re-found node's live box. */
  | {
      readonly kind: 'within';
      readonly descriptor: TraceTargetDescriptor;
      readonly fx: number;
      readonly fy: number;
      /** The recorded point and its viewport, the fallback when the node cannot be re-found. */
      readonly point: ViewportPoint;
      readonly viewport: { readonly width: number; readonly height: number };
    };

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
      return {
        kind: 'scroll',
        direction: action.direction,
        ...(action.target === undefined ? {} : { descriptor: action.target }),
        ...(action.spans === undefined ? {} : { spans: action.spans }),
        times: action.times ?? 1,
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
        : {
            kind: 'within',
            descriptor: action.within.target,
            fx: action.within.fx,
            fy: action.within.fy,
            point: action.point,
            viewport: action.viewport,
          };
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
          await repeat(host, planned.times, () => planned.invoke({ id: relocated.id }));
          break;
        }
        case 'free':
          await repeat(host, planned.times, () => planned.invoke());
          break;
        case 'scroll': {
          const { direction, descriptor } = planned;
          let lost: RelocationFailure | undefined;
          await repeat(host, planned.times, async () => {
            const relocated = descriptor === undefined ? undefined : await relocate(host, descriptor);
            if (relocated === undefined || relocated.kind !== 'failed') {
              await host.actions.scroll(direction, relocated === undefined ? undefined : { id: relocated.id });
              return;
            }
            if ((planned.spans ?? 0) < MAIN_LIST_SHARE) {
              lost = relocated.failure;
              return;
            }
            await host.actions.scroll(direction);
          });
          if (lost !== undefined) return stop(lost);
          break;
        }
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
          let box = relocated.kind === 'failed' ? undefined : relocated.node.rect;
          if (relocated.kind === 'failed' && relocated.failure === 'target-ambiguous') {
            // Several look-alikes: the recorded point says which one, when it
            // lies inside exactly one of them on a viewport of the recorded size.
            box = await boxAmongLookAlikes(host, planned.descriptor, planned.point, planned.viewport);
          }
          // A node that is gone, or a point that settles nothing, hands off:
          // tapping the bare point could press whatever now sits there.
          if (box === undefined || box.width <= 0 || box.height <= 0) {
            return stop(relocated.kind === 'failed' ? relocated.failure : 'target-not-found');
          }
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
 * Relocates one descriptor against the settling screen. Only a missing target
 * is worth another look; ambiguity never retries — two matching nodes will
 * not become one by waiting, and acting on either would be a guess.
 */
async function relocate(
  host: ReplayHost,
  descriptor: TraceTargetDescriptor,
): Promise<Relocated> {
  const options = { redact: host.redact };
  const settled = await pollSettled(host, ({ nodes }): Relocated | undefined => {
    const result = relocateDescriptor(descriptor, nodes, options);
    if (result.kind === 'failed') return result.failure === 'target-not-found' ? undefined : result;
    const node = nodes.get(result.id);
    return node === undefined ? undefined : { kind: 'found', id: result.id, node };
  });
  return settled ?? { kind: 'failed', failure: 'target-not-found' };
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

/** The share of the viewport a scrolled list must have covered when recorded to scroll as the viewport when lost. */
const MAIN_LIST_SHARE = 0.5;

/**
 * Among the nodes a descriptor matches, the box of the one that contains the
 * recorded point, on a viewport of the recorded size. Undefined when none or
 * several do, or the viewport differs: the point then decides nothing.
 */
async function boxAmongLookAlikes(
  host: ReplayHost,
  descriptor: TraceTargetDescriptor,
  point: ViewportPoint,
  recorded: { readonly width: number; readonly height: number },
): Promise<SemanticNode['rect'] | undefined> {
  const screen = await host.observeSettled();
  // Only a semantic capture lists nodes; pixels alone settle nothing.
  if (screen.kind !== 'semantic') return undefined;
  if (screen.viewport.width !== recorded.width || screen.viewport.height !== recorded.height) return undefined;
  const described = describeNodes(screen.nodes, { redact: host.redact });
  for (const tier of descriptorTiers(descriptor)) {
    const fields = (Object.keys(tier) as DescriptorField[]).filter((field) => field !== 'position');
    const matches = described.filter((node) => fieldsEqual(tier, node.descriptor, fields));
    if (matches.length === 0) continue;
    const containing = matches.filter((match) => {
      const rect = screen.nodes.get(match.id)?.rect;
      return (
        rect !== undefined &&
        rect.width > 0 &&
        rect.height > 0 &&
        point.x >= rect.x &&
        point.x < rect.x + rect.width &&
        point.y >= rect.y &&
        point.y < rect.y + rect.height
      );
    });
    return containing.length === 1 ? screen.nodes.get(containing[0]!.id)?.rect : undefined;
  }
  return undefined;
}

/**
 * Runs one planned action its recorded number of times. A folded scroll was
 * recorded as separate calls with a look between them, which is what gave a
 * lazy or paginated list time to render; replay keeps that pace.
 */
async function repeat(host: ReplayHost, times: number | undefined, invoke: () => Promise<void>): Promise<void> {
  const count = times ?? 1;
  for (let index = 0; index < count; index += 1) {
    await invoke();
    if (index < count - 1) await host.observeSettled();
  }
}
