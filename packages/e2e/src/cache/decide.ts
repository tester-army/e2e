/**
 * The per-step replay decision.
 *
 * Pure and fail-to-miss: every reason a validated entry cannot replay is a
 * miss that dispatches the live executor, never an error and never a step
 * failure. Validation has one owner — the store (`readTraceEntry`) — so this
 * decision takes an already-trusted entry and answers only the questions the
 * entry alone cannot: is it whole, and is the app where the recording began?
 */

import type { ActionTrace, TraceEntry } from './trace.ts';

/**
 * Whether two recorded locations are the same page. Pathname only, at both
 * ends of a trace: a volatile query string (`?utm=…`, a cache-busting stamp)
 * must not break zero-turn, and the relocated targets and end anchors — not
 * the query — are what prove the screen is the one the flow was proven on.
 */
export function samePathname(a: string, b: string): boolean {
  return pathnameOf(a) === pathnameOf(b);
}

function pathnameOf(path: string): string {
  return path.split('?')[0] ?? path;
}

/**
 * A path segment the app mints per record: a uuid, a hex or digit run of
 * eight or more, or a long random token (twelve or more url-safe characters
 * carrying a digit or both letter cases, which a plain lowercase word such as
 * `integrations` never does). Only such segments may differ between two
 * paths of the same shape.
 */
const MINTED_SEGMENT: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^\d{4,}$/,
  /^(?=.*(?:\d|[a-z][A-Za-z0-9_-]*[A-Z]|[A-Z][A-Za-z0-9_-]*[a-z]))[A-Za-z0-9_-]{12,}$/,
];

/**
 * Whether a live end path is the recorded one up to the identifiers the app
 * mints per record. A step that creates something ends on that thing's page,
 * and the next run's record has a different id, so an exact path could never
 * match again. Same segment count; every segment equal, or different only
 * where both look minted (`MINTED_SEGMENT`). The query is ignored as in
 * `samePathname`.
 */
export function samePathShape(recorded: string, live: string): boolean {
  if (samePathname(recorded, live)) return true;
  const expected = pathnameOf(recorded).split('/');
  const actual = pathnameOf(live).split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const other = actual[index] ?? '';
    if (segment === other) return true;
    return MINTED_SEGMENT.some((pattern) => pattern.test(segment) && pattern.test(other));
  });
}

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
 * not open with a navigate carries a start-path precondition: the app must
 * be on the page where the recording began, or the recorded actions would
 * run against a different screen than they were proven on. "The page" is
 * the path up to the ids the app mints per record (`samePathShape`), as at
 * the end of a trace: a step that edits the record a previous step created
 * starts on `/companies/<id>`, and that id is new on every run.
 */
export function decideTraceReplay(
  entry: TraceEntry,
  currentPath: string | undefined,
): TraceReplayDecision {
  if (entry.payload.truncated === true) return { action: 'miss', reason: 'truncated' };
  if (!opensWithNavigate(entry.payload)) {
    const startPath = entry.payload.startPath;
    if (startPath === undefined || currentPath === undefined || !samePathShape(startPath, currentPath)) {
      return { action: 'miss', reason: 'wrong-context' };
    }
  }
  return { action: 'replay' };
}
