/**
 * Zero-turn trace replay (RFC0001 layer 3, cache-in decision).
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

import { relocateDescriptor } from '../cache/relocate.ts';
import type { ActionTrace, RecordedAction, TraceTargetDescriptor } from '../cache/trace.ts';
import type { SemanticNode } from '../backend/surface.ts';
import { sleep } from '../internal/time.ts';
import { isAgentError } from './error.ts';
import {
  RUNTIME_CODES,
  type ExecutorActions,
  type ExecutorTarget,
  type ReplayHandOffReason,
} from './executor.ts';
import { settleObservation } from './observation.ts';

/** Backoff between relocation attempts while the screen settles. */
const RELOCATION_RETRY_DELAYS_MS = [100, 300, 600, 1_000, 3_000] as const;

/** Ceiling on one action's relocation, inside whatever the deadline allows. */
const RELOCATION_TIMEOUT_MS = 15_000;

/** What the replay engine needs from the dispatch, and nothing more. */
export interface ReplayHost {
  /** Captures a fresh observation and returns its node map. */
  observeNodes(): Promise<ReadonlyMap<string, SemanticNode>>;
  /** Id-independent shape of the newest observation, for settle detection. */
  latestShape(): string | undefined;
  /** The step's policed action grammar; targets are fresh-observation ids. */
  readonly actions: ExecutorActions;
  readonly signal: AbortSignal;
  remainingMs(): number;
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
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
  | { readonly kind: 'free'; readonly invoke: () => Promise<void> };

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
  }
}

/** Replays one trace until it completes or diverges. */
export async function replayTrace(host: ReplayHost, trace: ActionTrace): Promise<ReplayOutcome> {
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
    const planned = planCall(action, host.actions);
    if (planned.kind === 'gap') return stop('gap');
    try {
      if (planned.kind === 'targeted') {
        const relocated = await relocate(host, planned.descriptor);
        if (relocated.kind === 'failed') return stop(relocated.failure);
        await planned.invoke({ id: relocated.id });
      } else {
        await planned.invoke();
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
 * Relocates one descriptor with settling backoff: a screen mid-transition gets
 * a few fresh observations before replay gives the step up. Ambiguity never
 * retries — two matching nodes will not become one by waiting, and acting on
 * either would be a guess.
 */
async function relocate(
  host: ReplayHost,
  descriptor: TraceTargetDescriptor,
): Promise<{ kind: 'found'; id: string } | { kind: 'failed'; failure: ReplayHandOffReason }> {
  const startedMs = Date.now();
  let nodes = await settledNodes(host);
  for (let attempt = 0; ; attempt += 1) {
    const result = relocateDescriptor(descriptor, nodes, {
      redact: host.redact,
      testIdAttribute: host.testIdAttribute,
    });
    if (result.kind === 'found') return result;
    if (result.failure === 'target-ambiguous') return { kind: 'failed', failure: result.failure };
    const delay = RELOCATION_RETRY_DELAYS_MS[attempt];
    if (
      delay === undefined ||
      Date.now() - startedMs + delay > RELOCATION_TIMEOUT_MS ||
      host.remainingMs() <= delay
    ) {
      return { kind: 'failed', failure: 'target-not-found' };
    }
    await sleep(delay, host.signal);
    nodes = await host.observeNodes();
  }
}

/**
 * Pre-action settle: replay executes recorded actions far faster than the run
 * that recorded them; without this wait, an action can land while the app is
 * still reacting to the previous one — a form mid-clear, a list mid-update —
 * and commit something the recorded run never did. Same shared loop the
 * executor-facing observe uses (observation.ts); replay reads raw
 * observations and buys its settling here, on its own schedule.
 */
function settledNodes(host: ReplayHost): Promise<ReadonlyMap<string, SemanticNode>> {
  return settleObservation(
    () => host.observeNodes(),
    () => host.latestShape(),
    host,
  );
}

/**
 * True for errors a replay must surface rather than absorb as divergence:
 * runtime hard stops and cancellation are the step's own accounting.
 */
function isReplayFatal(cause: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return isAgentError(cause) && RUNTIME_CODES.has(cause.code);
}
