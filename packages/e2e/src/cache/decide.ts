/**
 * The per-step replay decision (RFC0001 layer 3, cache-in decision).
 *
 * Pure and fail-to-miss: every reason a validated entry cannot replay is a
 * miss that dispatches the live executor, never an error and never a step
 * failure. Validation has one owner — the store (`readTraceEntry`) — so this
 * decision takes an already-trusted entry and answers only the questions the
 * entry alone cannot: is it whole, and is the app where the recording began?
 */

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
 * Pathname-only comparison of a live path against a recorded anchor: volatile
 * query strings (tracking parameters, cache busters) must break neither the
 * start precondition nor the end postcondition. Both anchors use this one
 * rule, so an entry that replays also finalizes under the same reading of
 * "the same page". An unknown live path is not evidence against the anchor.
 */
export function samePathname(current: string | undefined, recorded: string): boolean {
  if (current === undefined) return true;
  return pathnameOf(current) === pathnameOf(recorded);
}

function pathnameOf(value: string): string {
  return value.split('?')[0] ?? value;
}

/**
 * The full miss vocabulary of the report. `no-entry` and `invalid-entry` are
 * assigned by the store-read path; this decision produces the other two.
 */
export type TraceReplayMissReason = 'no-entry' | 'invalid-entry' | 'truncated' | 'wrong-context';

export type TraceReplayDecision =
  | { readonly action: 'replay' }
  | { readonly action: 'miss'; readonly reason: 'truncated' | 'wrong-context' };

/**
 * Decides whether one entry replays for the current step. A trace that does
 * not open with a navigate carries a start-path precondition: the app must
 * be where the recording began, or the recorded actions would run against a
 * different screen than they were proven on.
 */
export function decideTraceReplay(
  entry: TraceEntry,
  currentPath: string | undefined,
): TraceReplayDecision {
  if (entry.payload.truncated === true) return { action: 'miss', reason: 'truncated' };
  if (!opensWithNavigate(entry.payload)) {
    const startPath = entry.payload.startPath;
    if (
      startPath === undefined ||
      currentPath === undefined ||
      !samePathname(currentPath, startPath)
    ) {
      return { action: 'miss', reason: 'wrong-context' };
    }
  }
  return { action: 'replay' };
}
