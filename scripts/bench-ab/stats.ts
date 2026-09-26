/**
 * Paired statistics for `bench-ab.ts`. Every estimate is the median of the
 * per-pair log ratios `ln(head / base)`, reported as a percent change, with a
 * seeded bootstrap interval, so one slow outlier moves nothing and the same
 * samples always give the same answer.
 */

/** The verdict a metric's interval supports against a `±threshold` dead zone. */
export type Verdict = 'faster' | 'slower' | 'same' | 'unresolved';

export interface Delta {
  /** Median change, head over base: `0.05` is 5% slower. */
  readonly estimate: number;
  /** Bootstrap interval of `estimate` at `level`. */
  readonly low: number;
  readonly high: number;
  readonly level: number;
  readonly pairs: number;
  readonly verdict: Verdict;
}

/** A deterministic PRNG (mulberry32), so a bootstrap is reproducible from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `q` quantile of `values` by linear interpolation; `NaN` for none. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  return low + (sorted[upper]! - low) * (position - lower);
}

/** The median of `values`. */
export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/**
 * Where a change interval sits against the dead zone `(-threshold, +threshold)`:
 * wholly below it is faster, wholly above slower, wholly inside the same,
 * and one that straddles an edge is not resolved yet.
 */
export function verdictOf(low: number, high: number, threshold: number): Verdict {
  if (high < -threshold) return 'faster';
  if (low > threshold) return 'slower';
  if (low > -threshold && high < threshold) return 'same';
  return 'unresolved';
}

/**
 * The paired change of head over base. Pairs with a non-positive side are
 * dropped: a ratio needs two durations. The interval is a percentile
 * bootstrap of the median log ratio.
 */
export function pairedDelta(
  pairs: readonly (readonly [base: number, head: number])[],
  options: { threshold: number; level?: number; resamples?: number; seed?: number },
): Delta {
  const level = options.level ?? 0.95;
  const ratios = pairs.filter(([base, head]) => base > 0 && head > 0).map(([base, head]) => Math.log(head / base));
  if (ratios.length === 0) {
    return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN, level, pairs: 0, verdict: 'unresolved' };
  }
  const random = seededRandom(options.seed ?? 1);
  const resamples = options.resamples ?? 4000;
  const medians: number[] = [];
  const draw: number[] = Array.from({ length: ratios.length }, () => 0);
  for (let round = 0; round < resamples; round += 1) {
    for (let index = 0; index < ratios.length; index += 1) {
      draw[index] = ratios[Math.floor(random() * ratios.length)]!;
    }
    medians.push(median(draw));
  }
  const tail = (1 - level) / 2;
  const low = Math.expm1(quantile(medians, tail));
  const high = Math.expm1(quantile(medians, 1 - tail));
  return {
    estimate: Math.expm1(median(ratios)),
    low,
    high,
    level,
    pairs: ratios.length,
    verdict: ratios.length < 2 ? 'unresolved' : verdictOf(low, high, options.threshold),
  };
}
