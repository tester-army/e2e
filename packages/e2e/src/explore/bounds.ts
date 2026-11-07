/**
 * The limits of `e2e explore --max-steps`, `--timeout`, and `--parallel`. Apart from the
 * explorer so the CLI defines the flags without loading it.
 */

/** Exploration steps per run, at most: the planner finishes earlier once nothing new is reachable. */
export const STEP_BOUNDS = { min: 1, max: 100, default: 8 } as const;
/** Each explorer's time budget in milliseconds: three minutes to two hours. */
export const TIMEOUT_BOUNDS = { min: 180_000, max: 7_200_000, default: 600_000 } as const;
/** Explorers one exploration may run at once. */
export const PARALLEL_BOUNDS = { min: 1, max: 5, default: 1 } as const;
