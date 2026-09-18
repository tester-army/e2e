/**
 * The per-step replay decision.
 *
 * Pure and fail-to-miss: every reason a validated entry cannot replay is a
 * miss that dispatches the live executor, never an error and never a step
 * failure. Validation has one owner — the store (`readTraceEntry`) — so this
 * decision takes an already-trusted entry and answers only the questions the
 * entry alone cannot: is it whole, and is the app where the recording began?
 */

import { compareRoutes, routeOf } from './route.ts';
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

/**
 * Decides whether one entry replays for the current step. A trace that does
 * not open with a navigate carries a start precondition: the app must be on
 * the screen where the recording began, or the recorded actions would run
 * against a different screen than they were proven on. The screen is its
 * route (`routeOf`), not its URL; a route the path leaves undecided is a
 * miss, since nothing recorded at the start is specific enough to settle it.
 */
export function decideTraceReplay(entry: TraceEntry, currentPath: string | undefined): TraceReplayDecision {
  const trace = entry.payload;
  if (trace.truncated === true) return { action: 'miss', reason: 'truncated' };
  if (opensWithNavigate(trace)) return { action: 'replay' };
  if (trace.startPath === undefined || currentPath === undefined) return { action: 'miss', reason: 'wrong-context' };
  return compareRoutes(routeOf(trace.startPath), routeOf(currentPath)) === 'same'
    ? { action: 'replay' }
    : { action: 'miss', reason: 'wrong-context' };
}
