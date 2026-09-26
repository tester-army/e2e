/**
 * Compares the paired samples of two builds. Behavior comes first: a test
 * whose status or step sequence differs between base and head, or between
 * two runs of one build, is reported and left out of the timing verdicts,
 * since its time measures different work. Counters are compared exactly.
 * Timings get a paired estimate with an interval (`stats.ts`).
 */

import type { Sample } from './sample.ts';
import { median, pairedDelta, quantile, type Delta } from './stats.ts';

export type CaseChange =
  | { readonly kind: 'added' | 'removed'; readonly key: string }
  | { readonly kind: 'changed'; readonly key: string; readonly base: string; readonly head: string }
  | { readonly kind: 'unstable'; readonly key: string; readonly side: 'base' | 'head'; readonly variants: number };

export interface CounterRow {
  readonly name: string;
  readonly base: readonly [min: number, max: number];
  readonly head: readonly [min: number, max: number];
}

export interface TimingRow {
  readonly name: string;
  readonly base: Spread;
  readonly head: Spread;
  readonly delta: Delta;
  /** True when the median paired difference is under the floor, which makes the verdict `same` whatever the ratio says. */
  readonly belowFloor: boolean;
}

/** What counts as a change: a ratio outside `±threshold`, and a paired difference of at least `floorMs`. */
export interface Limits {
  readonly threshold: number;
  readonly floorMs: number;
}

/** Median and interquartile range of one side. */
export interface Spread {
  readonly median: number;
  readonly q1: number;
  readonly q3: number;
}

export interface Comparison {
  readonly pairs: number;
  readonly changes: readonly CaseChange[];
  /** Counters whose range differs between the sides, or varies within one. */
  readonly counters: readonly CounterRow[];
  /**
   * The process wall clock, then totals over the tests whose behavior matched:
   * the suite, the event phases, and each step api.
   */
  readonly timings: readonly TimingRow[];
  /** Tests whose own duration resolved outside the threshold. */
  readonly cases: readonly TimingRow[];
  /** Tests timed per case, for the multiple-comparison note. */
  readonly casesCompared: number;
}

function spread(values: readonly number[]): Spread {
  return { median: median(values), q1: quantile(values, 0.25), q3: quantile(values, 0.75) };
}

function range(values: readonly number[]): readonly [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

/**
 * One timing compared pair by pair. A millisecond step rounds to a large
 * ratio, so a paired difference under the floor reads as `same`.
 */
function timingRow(name: string, base: readonly number[], head: readonly number[], limits: Limits): TimingRow {
  const delta = pairedDelta(base.map((value, index) => [value, head[index]!] as const), { threshold: limits.threshold });
  const belowFloor = Math.abs(median(head.map((value, index) => value - base[index]!))) < limits.floorMs;
  return {
    name,
    base: spread(base),
    head: spread(head),
    delta: belowFloor ? { ...delta, verdict: 'same' } : delta,
    belowFloor,
  };
}

/** The distinct signatures of a case across one side's runs; a run without the case counts as a variant of its own. */
function signatures(samples: readonly Sample[], key: string): Set<string> {
  return new Set(samples.map((sample) => sample.cases.get(key)?.signature ?? ABSENT));
}

const ABSENT = '(absent)';

function caseChanges(base: readonly Sample[], head: readonly Sample[]): CaseChange[] {
  const keys = new Set([...base, ...head].flatMap((sample) => [...sample.cases.keys()]));
  const changes: CaseChange[] = [];
  for (const key of [...keys].toSorted()) {
    const inBase = signatures(base, key);
    const inHead = signatures(head, key);
    const only = (set: Set<string>, value: string) => set.size === 1 && set.has(value);
    if (only(inBase, ABSENT)) changes.push({ kind: 'added', key });
    else if (only(inHead, ABSENT)) changes.push({ kind: 'removed', key });
    else if (inBase.size > 1) changes.push({ kind: 'unstable', key, side: 'base', variants: inBase.size });
    else if (inHead.size > 1) changes.push({ kind: 'unstable', key, side: 'head', variants: inHead.size });
    else {
      const [baseSignature] = inBase;
      const [headSignature] = inHead;
      if (baseSignature !== headSignature) changes.push({ kind: 'changed', key, base: baseSignature!, head: headSignature! });
    }
  }
  return changes;
}

/** The headline row: the attempts of every comparable test, summed. */
export const SUITE = 'suite (sum of attempts)';
const PHASES = ['observe (events)', 'action (events)', 'model (events)'];

/** Compares `base[i]` with `head[i]` for every pair. The arrays must be the same length. */
export function compareSamples(base: readonly Sample[], head: readonly Sample[], limits: Limits): Comparison {
  if (base.length !== head.length) throw new Error(`unpaired samples: ${base.length} base, ${head.length} head`);
  const changes = caseChanges(base, head);
  const excluded = new Set(changes.map((change) => change.key));

  const counterNames = new Set([...base, ...head].flatMap((sample) => Object.keys(sample.counters)));
  const counters: CounterRow[] = [];
  for (const name of [...counterNames].toSorted()) {
    const baseRange = range(base.map((sample) => sample.counters[name] ?? 0));
    const headRange = range(head.map((sample) => sample.counters[name] ?? 0));
    const stable = baseRange[0] === baseRange[1] && headRange[0] === headRange[1];
    if (!stable || baseRange[0] !== headRange[0]) counters.push({ name, base: baseRange, head: headRange });
  }

  // Every case left has one signature on both sides, so it is in every run.
  const comparable = [...new Set(base.flatMap((sample) => [...sample.cases.keys()]))]
    .filter((key) => !excluded.has(key))
    .toSorted();
  // Run totals over the comparable cases only: a test whose behavior changed
  // did different work, and its time would read as a speedup or a slowdown.
  const total = (sample: Sample, name: string) =>
    comparable.reduce((sum, key) => {
      const entry = sample.cases.get(key)!;
      return sum + (name === SUITE ? entry.durationMs : (entry.timings[name] ?? 0));
    }, 0);
  const timingNames = [SUITE, ...PHASES, ...new Set(comparable.flatMap((key) => base.flatMap((sample) => Object.keys(sample.cases.get(key)!.timings))))];
  const rows = [...new Set(timingNames)]
    .map((name) => timingRow(name, base.map((sample) => total(sample, name)), head.map((sample) => total(sample, name)), limits))
    .filter((row) => row.base.median > 0 || row.head.median > 0);
  const isStep = (row: TimingRow) => row.name.startsWith('step ');
  const timings = [
    timingRow('wall (process)', base.map((sample) => sample.wallMs), head.map((sample) => sample.wallMs), limits),
    ...rows.filter((row) => !isStep(row)),
    ...rows.filter(isStep).toSorted((a, b) => b.base.median - a.base.median),
  ];

  const cases = comparable
    .map((key) => timingRow(
      key,
      base.map((sample) => sample.cases.get(key)!.durationMs),
      head.map((sample) => sample.cases.get(key)!.durationMs),
      limits,
    ))
    .filter((row) => row.delta.verdict === 'faster' || row.delta.verdict === 'slower');

  return { pairs: base.length, changes, counters, timings, cases, casesCompared: comparable.length };
}
