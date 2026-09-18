/**
 * The per-step replay decision.
 *
 * Pure and fail-to-miss: every reason a validated entry cannot replay is a
 * miss that dispatches the live executor, never an error and never a step
 * failure. Validation has one owner — the store (`readTraceEntry`) — so this
 * decision takes an already-trusted entry and answers only the questions the
 * entry alone cannot: is it whole, and is the app where the recording began?
 */

import type { SemanticNode } from '../engine/surface.ts';
import type { DescriptorMatchOptions } from './relocate.ts';
import { routeOf, sameRoute, screenSignature, signatureMatches } from './route.ts';
import type { ActionTrace, TraceEntry } from './trace.ts';

/**
 * Whether a trace establishes its own starting point by navigating first.
 * Such a trace needs no start-path precondition — and a trace with neither
 * anchor can never replay at all, so it is not worth writing.
 */
export function opensWithNavigate(trace: ActionTrace): boolean {
  return trace.actions.find((action) => action.name !== 'tool')?.name === 'navigate';
}

/**
 * The full miss vocabulary of the report. `retry` is assigned before any read:
 * a retry attempt records but never replays. `no-entry` and `invalid-entry`
 * are assigned by the store-read path; this decision produces the other two.
 */
export type TraceReplayMissReason = 'retry' | 'no-entry' | 'invalid-entry' | 'truncated' | 'wrong-context';

export type TraceReplayDecision =
  | { readonly action: 'replay' }
  | { readonly action: 'miss'; readonly reason: 'truncated' | 'wrong-context' };

/** The live screen a replay is decided against. */
export interface ReplayContext extends DescriptorMatchOptions {
  /** The location the engine reports now, when it reports one. */
  readonly path: string | undefined;
  /** The semantic screen now, when it could be observed; the arbiter for a route the path alone cannot settle. */
  readonly nodes: ReadonlyMap<string, SemanticNode> | undefined;
  /** This call's `unique()` values, which name a record wherever they appear in a path. */
  readonly knownValues: readonly string[];
}

/**
 * Decides whether one entry replays for the current step. A trace that does
 * not open with a navigate carries a start precondition: the app must be on
 * the screen where the recording began, or the recorded actions would run
 * against a different screen than they were proven on. The screen is its
 * route (`routeOf`), not its URL; where the route alone cannot tell, the
 * recorded signature of the start screen against the live one does.
 */
export function decideTraceReplay(entry: TraceEntry, context: ReplayContext): TraceReplayDecision {
  const trace = entry.payload;
  if (trace.truncated === true) return { action: 'miss', reason: 'truncated' };
  if (opensWithNavigate(trace)) return { action: 'replay' };
  if (trace.startPath === undefined || context.path === undefined) return { action: 'miss', reason: 'wrong-context' };
  const recorded = routeOf(trace.startPath, context.knownValues);
  const live = routeOf(context.path, context.knownValues);
  const sameScreen = sameRoute(recorded, live, () => {
    if (trace.startScreen === undefined || context.nodes === undefined) return false;
    return signatureMatches(trace.startScreen, screenSignature(context.nodes, context, context.knownValues));
  });
  return sameScreen ? { action: 'replay' } : { action: 'miss', reason: 'wrong-context' };
}
