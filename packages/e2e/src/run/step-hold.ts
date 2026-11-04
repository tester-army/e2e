/**
 * Holding steps for `e2e run --step`. A worker holds a top-level step before
 * it runs and asks the runner, which owns the terminal, whether it may; the
 * runner asks its `beforeStep` hook. While any step of an attempt is held, the
 * attempt's test clock is stopped, so the time a person spends looking at the
 * app is never charged to the test.
 */

import { abortError, cancelledError } from '../internal/time.ts';
import type { SourceLocation } from '../internal/source.ts';
import type { AttemptBudget } from './budget.ts';
import type { StepHoldRequest } from './steps.ts';

/** A step held before it runs, as the runner's `beforeStep` hook sees it. */
export interface HeldStep {
  readonly target: string;
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  /** The test's title path, joined with ` › `. */
  readonly title: string;
  readonly api: string;
  /** Already redacted. */
  readonly label: string;
  readonly source?: SourceLocation;
}

/** A held step with its place among its test's held steps, from 1. */
export interface NumberedStep {
  readonly step: HeldStep;
  readonly number: number;
}

/** The held steps one key lets run, as the prompt shows them. */
export interface StepPrompt {
  /** One step, or every step held together, as in one `Promise.all`. */
  readonly steps: readonly [NumberedStep, ...NumberedStep[]];
  /** List every key, not only the short line; `h` turns it on and off. */
  readonly help: boolean;
}

/** What the runner hands `beforeStep` beside the step. */
export interface StepHoldContext {
  /** Aborts once the answer no longer matters: the step was abandoned, its attempt ended, or the run was interrupted. */
  readonly signal: AbortSignal;
  /**
   * Shows the step waiting for a key, or no prompt: under its test in the
   * list reporter's live window, else on stderr.
   */
  show(prompt: StepPrompt | undefined): void;
}

/**
 * Decides when a held step runs: it resolves to run it. To stop instead,
 * interrupt the run; the interrupt aborts `context.signal`. A rejection
 * stops the run with that error.
 */
export type BeforeStep = (step: HeldStep, context: StepHoldContext) => Promise<void>;

/** What an attempt's holds need from the attempt. */
export interface AttemptHoldsOptions {
  readonly budget: AttemptBudget;
  /** Aborts when the attempt is cut short (a timeout, an interrupt): every hold ends and none starts. */
  readonly signal: AbortSignal;
  /** Asks the runner whether `step` may run; the same contract as `BeforeStep`. */
  readonly ask: (step: StepHoldRequest, signal: AbortSignal) => Promise<void>;
  /** The test clock runs again, with `remainingMs` left: the last pending hold ended. */
  readonly onResume: (remainingMs: number) => void;
}

/**
 * The holds of one attempt and the test clock they stop. The clock stops
 * when the first hold begins and runs again when no hold is pending, so
 * steps held together in one `Promise.all` are charged their wait once.
 * Every release hands the phase a fresh deadline of what was left when the
 * clock stopped, so a released step starts with that budget even while a
 * step beside it is still held.
 */
export class AttemptHolds {
  private pending = 0;
  private remainingMs = 0;
  /** The body's deadline timer, while `race` runs. */
  private timer: { stop(): void; check(): void } | undefined;

  constructor(private readonly options: AttemptHoldsOptions) {}

  /** The hold a `StepRecorder` takes; see `StepRecorderOptions.hold`. */
  readonly hold = async (step: StepHoldRequest, signal: AbortSignal): Promise<void> => {
    const cancel = AbortSignal.any([signal, this.options.signal]);
    if (cancel.aborted) throw abortError(cancel, cancelledError);
    if (this.pending === 0) {
      this.remainingMs = this.options.budget.deadline.remaining();
      // Already past it, as after code that blocked the event loop: the body times out now, not after a prompt.
      if (this.remainingMs === 0 && this.timer !== undefined) {
        this.timer.check();
        return;
      }
      this.timer?.stop();
    }
    this.pending += 1;
    try {
      await this.options.ask(step, cancel);
    } finally {
      this.pending -= 1;
      this.options.budget.resetDeadline(this.remainingMs);
      if (this.pending === 0) {
        this.timer?.check();
        this.options.onResume(this.remainingMs);
      }
    }
  };

  /**
   * Races the body against the phase's deadline, as read at each check, and
   * checks nothing while a step is held: the test times out on the budget it
   * had left, never during a hold. `onTimeout` builds the error it rejects with.
   */
  race<T>(work: Promise<T>, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let handle: NodeJS.Timeout | undefined;
      const stop = (): void => {
        clearTimeout(handle);
        handle = undefined;
      };
      const check = (): void => {
        stop();
        if (this.pending > 0) return;
        const remaining = this.options.budget.deadline.remaining();
        if (remaining > 0) handle = setTimeout(check, remaining);
        else reject(onTimeout());
      };
      this.timer = { stop, check };
      check();
      work.then(resolve, reject).finally(() => {
        stop();
        this.timer = undefined;
      });
    });
  }
}
