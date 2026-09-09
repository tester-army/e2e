/**
 * The observation byte budget both agent tiers capture under. The judgment
 * tier derived it first; the act loop reuses it so a dense page costs the same
 * bounded slice of the per-call token ceiling in either path.
 */

import { imageTokenUpperBound } from './model/adapter.ts';

/**
 * Headroom reserved for the method instruction and parameters, in the
 * byte-scaled units `tokenUpperBound` works in.
 */
const INSTRUCTION_RESERVE = 4_096;

/**
 * Headroom reserved for one attached screenshot on a vision call, in the same
 * units.
 *
 * The exact cost is only known once the observation reports its viewport, which
 * is after the observation budget has to be fixed, so this reserves for the
 * largest viewport worth planning for. It is derived through the same function
 * the adapter bills with, rather than guessed, so the two cannot drift: a
 * hard-coded 4,096 was already short of a 1440p capture at 4,784.
 *
 * Reserving too much only costs observation bytes when the per-call token ceiling
 * binds, and there a truncated tree the model can see is better than the
 * adapter's pre-flight rejecting the call outright. A viewport beyond this is
 * still safe for that reason: the pre-flight computes the real figure.
 */
const PIXEL_RESERVE = imageTokenUpperBound({ width: 2_560, height: 1_440 });

/** Floor below which a clamped budget never falls; a tree this small still names the visible controls. */
const MIN_OBSERVATION_BYTES = 1_024;

export interface ObservationBudgetLimits {
  /** `agent.maxObservationBytes`: the configured ceiling. */
  readonly maxObservationBytes: number;
  /** `limits.maxModelTokensPerCall`: the per-call ceiling the adapter pre-flights. */
  readonly maxModelTokensPerCall: number;
}

export interface ObservationBudgetRequest {
  /** Bytes the rest of the request already costs: system message, ledger, context. */
  readonly fixedBytes: number;
  /** Whether a screenshot travels with the tree, reserving its token cost too. */
  readonly pixels: boolean;
}

/**
 * Bytes one observation may contribute to a request.
 *
 * `agent.maxObservationBytes` is the configured ceiling, but the per-call
 * token limit binds first on a large screen. Deriving the budget from what the
 * rest of the request actually costs makes a big screen truncate visibly rather
 * than fail the adapter's pre-flight check.
 */
export function observationByteBudget(
  limits: ObservationBudgetLimits,
  request: ObservationBudgetRequest,
): number {
  const overhead = request.fixedBytes + INSTRUCTION_RESERVE + (request.pixels ? PIXEL_RESERVE : 0);
  const withinTokenCeiling = Math.max(
    MIN_OBSERVATION_BYTES,
    limits.maxModelTokensPerCall - overhead,
  );
  return Math.min(limits.maxObservationBytes, withinTokenCeiling);
}
