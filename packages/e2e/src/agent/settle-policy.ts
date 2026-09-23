/**
 * How the screen is read after each kind of action.
 *
 * One table, keyed by the action grammar, answers both questions the runtime
 * asks once an action has committed: how long the next settled look waits
 * for the screen to leave the shape the action was resolved against (the
 * dispatcher arms it), and how far the replay's look before the next action
 * settles. A new action kind does not compile until it declares both, and
 * the live loop and replay can never disagree about the same action.
 */

import type { RecordedAction } from '../cache/trace.ts';

/**
 * How far one look settles.
 *
 * - `raw`: the screen as it is, for the looks between retries and a start
 *   capture that serves the path alone.
 * - `after-change`: waits for the screen to leave the previous action's
 *   shape, then reads the first capture after it. Enough after a fill, whose
 *   effect is confined to the field it acted on: the relocation reads a
 *   capture taken after the value landed and spends no beat proving that a
 *   typed value stays typed.
 * - `held-still`: after the change wait, captures a beat apart until two
 *   agree in shape. Needed after an action that can submit, open, move, or
 *   replace the screen; without it a replayed action lands on a form
 *   mid-clear or a list mid-update and commits something the recorded run
 *   never did.
 */
export type SettleMode = 'raw' | 'after-change' | 'held-still';

/**
 * How long a held-still look proves the new shape holds: captures a poll
 * apart until two agree, bounded so a screen that keeps moving costs one
 * wait, not the step.
 */
export const HELD_STILL_MS = 1_000;

/**
 * How long a settled look waits for the screen to move away from the shape
 * an action was resolved against before accepting that the action changed
 * nothing visible. A tap on a link starts a navigation that commits hundreds
 * of milliseconds later; a client-side route change swaps the document body
 * after a fetch; a submit renders its result after a round trip. Read too
 * early, the observation is the old page, stable and wrong, and a model
 * "repairs" what already worked. Bounded so a dead control costs one wait,
 * not the step.
 */
const FULL_CHANGE_WAIT_MS = 2_000;

/**
 * The change wait after a scroll or a mutating project tool. A scroll moves
 * nothing the tree records and a tool usually changes state the screen shows
 * only after a reload, so most of these change no shape at all and a long
 * wait is pure cost; a windowed list rendering its next rows, or a tool the
 * page reacts to, does so within a few hundred milliseconds.
 */
const BRIEF_CHANGE_WAIT_MS = 500;

/** What happens to the screen after one kind of action, as far as the runtime waits for it. */
interface SettleAfter {
  /**
   * How long the next settled look waits for the screen to leave the shape
   * the action was resolved against. Absent for an action whose effect the
   * tree cannot show: a secret fill is masked out of every capture, so a
   * change wait after it could never be satisfied and would only cost time.
   */
  readonly changeWaitMs?: number;
  /** How far the replay's look before the next action settles. */
  readonly look: SettleMode;
}

/**
 * The settle policy per action kind. A `tool` entry is a gap: replay stops
 * at it, so its `look` is never taken, while the live loop arms its change
 * wait after every mutating project tool.
 */
export const SETTLE_AFTER: Record<RecordedAction['name'], SettleAfter> = {
  tap: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  type: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'after-change' },
  typeSecret: { look: 'held-still' },
  press: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  select: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  scroll: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
  navigate: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  tapAt: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  typeText: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'after-change' },
  pressKey: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  dismissKeyboard: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  tool: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
};
