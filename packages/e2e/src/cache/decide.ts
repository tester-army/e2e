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
import { anchorsShare } from './anchors.ts';
import type { DescriptorMatchOptions } from './relocate.ts';
import { compareRoutes, routeOf } from './route.ts';
import type { ActionTrace, TraceEntry } from './trace.ts';

/** How much of a recorded start screen must be on screen again for an undecided route to be the same screen. */
const START_ANCHORS_SHARE = 0.6;
/** Fewer recorded start anchors than this cannot tell one screen from another. */
const MIN_START_ANCHORS = 4;

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
  /** The semantic screen now, when it could be observed; what settles a route the path alone cannot. */
  readonly nodes: ReadonlyMap<string, SemanticNode> | undefined;
}

/**
 * Decides whether one entry replays for the current step. A trace that does
 * not open with a navigate carries a start precondition: the app must be on
 * the screen where the recording began, or the recorded actions would run
 * against a different screen than they were proven on. The screen is its
 * route (`routeOf`), not its URL; a route the path alone leaves undecided is
 * the same screen when most of the recorded start anchors are on it again.
 */
export function decideTraceReplay(entry: TraceEntry, context: ReplayContext): TraceReplayDecision {
  const trace = entry.payload;
  if (trace.truncated === true) return { action: 'miss', reason: 'truncated' };
  if (opensWithNavigate(trace)) return { action: 'replay' };
  if (trace.startPath === undefined || context.path === undefined) return { action: 'miss', reason: 'wrong-context' };
  const verdict = compareRoutes(routeOf(trace.startPath), routeOf(context.path));
  const sameScreen =
    verdict === 'same' ||
    (verdict === 'undecided' &&
      trace.startAnchors !== undefined &&
      trace.startAnchors.length >= MIN_START_ANCHORS &&
      context.nodes !== undefined &&
      anchorsShare(trace.startAnchors, context.nodes, context) >= START_ANCHORS_SHARE);
  return sameScreen ? { action: 'replay' } : { action: 'miss', reason: 'wrong-context' };
}
