/**
 * What one assertion poll read, round by round, kept as the distinct values
 * in the order they appeared: whether the screen never showed what was
 * expected, or showed it and moved on, is what separates a wrong
 * expectation from a race.
 */

import { bound } from '../cache/trace.ts';
import { timestamp } from '../internal/ids.ts';
import type { StepEvent } from '../run/steps.ts';

/** Characters of one reading the event keeps. */
const MAX_VALUE_CHARS = 80;
/** Distinct readings the event names: the first, then the latest ones. */
const MAX_RUNS = 4;
/** The report caps an event's detail at this many characters. */
const MAX_DETAIL_CHARS = 300;

interface Run {
  readonly value: string;
  count: number;
  /** Milliseconds from the first read to the first read of this value. */
  readonly atMs: number;
}

/** One poll's readings, folded as they come; `event` turns them into the step's `poll` event. */
export class SampleHistory {
  /**
   * `name` is what polled, as the event names it (`expect`, `waitFor`);
   * `redact` replaces secret values in a reading before it is clipped, so no
   * cut leaves a secret's head behind.
   */
  constructor(
    private readonly name: string,
    private readonly redact: (text: string) => string,
  ) {}

  private readonly startedAt = timestamp();
  private readonly startedMs = Date.now();
  private readonly runs: Run[] = [];
  private reads = 0;

  /** Adds one round's reading. */
  add(value: string): void {
    this.reads += 1;
    // Folded whole, so two long readings that differ past the clip stay two.
    const redacted = this.redact(value);
    const last = this.runs.at(-1);
    if (last?.value === redacted) last.count += 1;
    else this.runs.push({ value: redacted, count: 1, atMs: Date.now() - this.startedMs });
  }

  /**
   * The poll as one `poll` event: how many rounds it read over how long and,
   * when the reading changed or the poll failed, the readings in order,
   * `"2 remaining" x3 -> at 410ms "1 remaining" x12`.
   */
  event(status: StepEvent['status']): StepEvent {
    const told = this.runs.length > 1 || status !== 'passed';
    return {
      kind: 'poll',
      name: this.name,
      startedAt: this.startedAt,
      durationMs: Date.now() - this.startedMs,
      status,
      count: this.reads,
      ...(told && this.runs.length > 0 ? { detail: this.detail() } : {}),
    };
  }

  private detail(): string {
    const shown = this.runs.length <= MAX_RUNS ? this.runs : [this.runs[0]!, ...this.runs.slice(-(MAX_RUNS - 1))];
    const parts = shown.map((run, index) => {
      const skipped = index === 1 && shown.length < this.runs.length ? '… -> ' : '';
      const at = index === 0 ? '' : `at ${run.atMs}ms `;
      return `${skipped}${at}${bound(run.value, MAX_VALUE_CHARS)}${run.count > 1 ? ` x${run.count}` : ''}`;
    });
    const text = parts.join(' -> ');
    return bound(text, MAX_DETAIL_CHARS);
  }
}
