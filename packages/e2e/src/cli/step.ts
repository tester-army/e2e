/**
 * `e2e run --step`: the run's first step runs on its own, then every later
 * one waits for a key. The runner holds each step through its `beforeStep`
 * hook; this module answers it from the keyboard, one prompt at a time, and
 * the runner draws the prompt.
 */

import type { Keypress } from './keyboard.ts';
import type { BeforeStep, HeldStep, NumberedStep, StepHoldContext, StepPrompt } from '../run/step-hold.ts';
import { pairKey } from '../run/units.ts';

/** A key the step prompt acts on. Ctrl-C, Ctrl-D, and Ctrl-Z arrive as keypresses in raw mode, not as signals. */
export type StepKey = 'continue' | 'test' | 'rest' | 'help' | 'stop' | 'interrupt' | 'suspend';

/**
 * The step key a keypress means, or none. The keys follow `--watch`, as
 * vitest's do: Enter goes on, `a` runs all, `h` shows the keys, `q` and
 * Escape quit.
 */
export function stepKeyOf(press: Keypress): StepKey | undefined {
  if (press.ctrl) {
    if (press.name === 'c' || press.name === 'd') return 'interrupt';
    return press.name === 'z' ? 'suspend' : undefined;
  }
  switch (press.name) {
    case 'return':
    case 'enter':
      return 'continue';
    case 'n':
      return 'test';
    case 'a':
      return 'rest';
    case 'h':
      return 'help';
    case 'q':
    case 'escape':
      return 'stop';
    default:
      return undefined;
  }
}

/** What `e2e run --step <action>` asks a stepped run without a terminal to do (`step-control.ts`). */
export const STEP_ACTIONS = ['next', 'rest', 'stop'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Whether `e2e run --step <value>` drives a stepped run rather than naming a file. */
export function isStepAction(value: string | undefined): value is StepAction {
  return (STEP_ACTIONS as readonly (string | undefined)[]).includes(value);
}

/** How long a prompt ignores keys after it appears: a key pressed for the step before must not run this one. */
const KEY_GUARD_MS = 150;

/** One held step waiting for its prompt, or showing it. */
interface Waiting extends NumberedStep {
  readonly context: StepHoldContext;
  readonly resolve: () => void;
  readonly onAbort: () => void;
}

/** The test a step belongs to, on its target: what `t` lets through. */
function testKey(step: HeldStep): string {
  return `${step.target}\u0000${pairKey(step.testId, step.agent, step.repeat)}`;
}

/**
 * Answers held steps from keys, one prompt at a time, in the order the steps
 * were held. Steps of one test held together, as in one `Promise.all`, share
 * a prompt and run on one key: a wait started beside the action it waits for
 * would otherwise time out while the action waits for its key. `stop`
 * interrupts the run; the interrupt aborts every waiting step's signal,
 * which takes it off the queue.
 */
export class StepGate {
  private readonly queue: Waiting[] = [];
  private shownAt = 0;
  private started = false;
  private runRest = false;
  /** Whether the prompt lists every key, after `h`. */
  private help = false;
  /** The test `n` let through, until its steps stop coming. */
  private released: string | undefined;
  /** The test whose steps reached the gate last, and how many of them did. */
  private current: { readonly key: string; count: number } | undefined;
  /** Where the prompt shows; every hold's context shows it in the same place. */
  private show: StepHoldContext['show'] | undefined;

  private readonly now: () => number;
  private readonly keyGuardMs: number;

  /**
   * `stop` interrupts the run. `keyGuardMs` defaults to `KEY_GUARD_MS`; a
   * caller whose keys are commands, not presses that can repeat, passes 0.
   */
  constructor(
    private readonly stop: () => void,
    options: { readonly now?: () => number; readonly keyGuardMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.keyGuardMs = options.keyGuardMs ?? KEY_GUARD_MS;
  }

  /** The runner's `beforeStep` hook. */
  readonly beforeStep: BeforeStep = (step, context) => {
    // A hold that ended before it arrived has nobody to answer.
    if (context.signal.aborted) return Promise.resolve();
    this.show = context.show;
    const key = testKey(step);
    const number = this.count(key);
    // The first step runs at once, so the app is open before the first prompt.
    if (!this.started) {
      this.started = true;
      return Promise.resolve();
    }
    if (this.runRest || this.released === key) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiting: Waiting = {
        step,
        number,
        context,
        resolve,
        onAbort: () => {
          const index = this.queue.indexOf(waiting);
          if (index === -1) return;
          this.queue.splice(index, 1);
          resolve();
          if (index === 0 || this.onPrompt(key)) this.showNext();
        },
      };
      context.signal.addEventListener('abort', waiting.onAbort, { once: true });
      this.queue.push(waiting);
      // The first step held shows its prompt; a step held beside it joins that prompt.
      if (this.onPrompt(key)) this.showNext();
    });
  };

  /** Acts on one key. Ctrl-C works at any time; the others only on a prompt, once it has been up for the key guard. */
  press(key: Exclude<StepKey, 'suspend'>): void {
    if (key === 'interrupt') {
      this.stop();
      return;
    }
    const shown = this.queue[0];
    if (shown === undefined || this.now() - this.shownAt < this.keyGuardMs) return;
    const test = testKey(shown.step);
    switch (key) {
      case 'continue':
      case 'test':
        if (key === 'test') this.released = test;
        this.release((waiting) => testKey(waiting.step) === test);
        return;
      case 'rest':
        this.runRest = true;
        this.release(() => true);
        return;
      case 'help':
        // The same steps, so the key guard keeps running.
        this.help = !this.help;
        this.show?.(this.prompt());
        return;
      case 'stop':
        this.stop();
    }
  }

  /** Whether the prompt up now is for a step of the test `key` names. */
  private onPrompt(key: string): boolean {
    const shown = this.queue[0];
    return shown !== undefined && testKey(shown.step) === key;
  }

  /** Numbers the steps of one test as they reach the gate; a new test starts at 1 and ends what `n` let through. */
  private count(key: string): number {
    if (this.current?.key !== key) {
      this.current = { key, count: 0 };
      if (this.released !== key) this.released = undefined;
    }
    this.current.count += 1;
    return this.current.count;
  }

  /** Lets every waiting step `which` picks run, then shows the next prompt. */
  private release(which: (waiting: Waiting) => boolean): void {
    for (const waiting of this.queue.filter(which)) {
      this.queue.splice(this.queue.indexOf(waiting), 1);
      waiting.context.signal.removeEventListener('abort', waiting.onAbort);
      waiting.resolve();
    }
    this.showNext();
  }

  /** Shows the next prompt, or takes the prompt down when no step waits. */
  private showNext(): void {
    this.shownAt = this.now();
    this.show?.(this.prompt());
  }

  /** The prompt for the step first in the queue and the steps of its test held beside it, or none. */
  private prompt(): StepPrompt | undefined {
    const [first, ...rest] = this.queue;
    if (first === undefined) return undefined;
    const test = testKey(first.step);
    const numbered = ({ step, number }: Waiting): NumberedStep => ({ step, number });
    return { steps: [numbered(first), ...rest.filter((waiting) => testKey(waiting.step) === test).map(numbered)], help: this.help };
  }
}
