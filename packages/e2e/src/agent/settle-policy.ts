/**
 * How the screen is read after each kind of action.
 *
 * One table, keyed by the action grammar, answers both questions the runtime
 * asks once an action has committed: how long after it the screen has to
 * leave the shape the action was resolved against (the dispatcher arms it,
 * and the next settled look waits out what remains), and how far the
 * replay's look before the next action settles. A new action kind does not
 * compile until it declares both. The window is the table's, except that
 * `changeWaitAfter` shortens it for a caret key by reading the focus on the
 * newest screen the loop or the replay holds.
 */

import type { RecordedAction } from '../cache/trace.ts';
import { parseKey } from '../engine/contract.ts';

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
 * How long after an action a settled look waits for the screen to move away
 * from the shape the action was resolved against before accepting that the
 * action changed nothing visible. A tap on a link starts a navigation that
 * commits hundreds of milliseconds later; a client-side route change swaps
 * the document body after a fetch; a submit renders its result after a round
 * trip. Read too early, the observation is the old page, stable and wrong,
 * and a model "repairs" what already worked. Bounded so a dead control costs
 * one wait, not the step.
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
   * How long after the action the screen has to leave the shape it was
   * resolved against; capture time and delays before the next settled look
   * count toward it. Absent for an action whose effect the tree cannot
   * show: a secret fill is masked out of every capture, so a change wait
   * after it could never be satisfied and would only cost time.
   */
  readonly changeWaitMs?: number;
  /** How far the replay's look before the next action settles. */
  readonly look: SettleMode;
}

/**
 * The change wait after a caret key in a text field. A selection that changes
 * shows in the first capture after the key, but a handler on `selectionchange`
 * (a rich-text toolbar, a mention list) may update the tree a beat later, and
 * the tree cannot say whether one is listening. The wait is the span a screen
 * must hold still to count as settled, so a handler that updates within a
 * second is read, at half the cost of the full window. One slower than that
 * is read on the next look, as it is after any action with a shorter window.
 */
const CARET_CHANGE_WAIT_MS = HELD_STILL_MS;

/** Roles of a field a caret lives in. A `combobox` is left out: its keys open and move a popup. */
const CARET_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox']);

/**
 * Keys that only move a caret or extend a selection, alone or with modifiers.
 * Narrower than the agent's focus-only keys (`primitives.ts`): Tab and the
 * vertical keys leave the field or move a popup, so they keep the full wait.
 */
const CARET_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** The action a settle policy reads: its kind, its key, and the node it ran against. */
export interface SettleSubject {
  readonly name: RecordedAction['name'];
  readonly key?: string;
  readonly node?: { readonly role?: string | undefined; readonly states?: { readonly focused?: boolean | undefined } | undefined };
}

/** True for a text field that held the focus when the action reached it. */
function focusedTextField(node: SettleSubject['node']): boolean {
  return node?.states?.focused === true && CARET_ROLES.has(node.role ?? '');
}

/**
 * Whether the key moved a caret in a text field that already held the
 * focus, an effect the tree mostly cannot show. A selection it changes is
 * read at once, so the change wait only ever runs out on one that changed
 * nothing: a key at the end of the text, a second select-all. A tap is left
 * out, focused field or not: a click can open a popup or a panel that takes
 * longer than the short window to render. So is the first focus of a field,
 * since what a field opens when it takes the focus may arrive a beat later.
 * `focused` is the field a key press went to, which a keyboard action does
 * not name.
 */
function movesCaretOnly(action: SettleSubject, focused: SettleSubject['node']): boolean {
  if (action.name !== 'press' && action.name !== 'pressKey') return false;
  if (!focusedTextField(action.name === 'press' ? action.node : focused)) return false;
  const parsed = parseKey(action.key ?? '');
  if (parsed === undefined || parsed.modifiers.includes('Alt')) return false;
  if (parsed.key.kind === 'named') return CARET_KEYS.has(parsed.key.name);
  const [only, ...rest] = parsed.modifiers;
  return parsed.key.char === 'a' && rest.length === 0 && (only === 'Control' || only === 'Meta' || only === 'ControlOrMeta');
}

/**
 * How long after the committed action the screen has to leave the shape it
 * was resolved against (`SETTLE_AFTER`'s window, shortened for an action
 * that only moves a caret): absent when the tree cannot show the effect.
 */
export function changeWaitAfter(action: SettleSubject, focused?: SettleSubject['node']): number | undefined {
  const { changeWaitMs } = SETTLE_AFTER[action.name];
  if (changeWaitMs === undefined || changeWaitMs <= CARET_CHANGE_WAIT_MS) return changeWaitMs;
  return movesCaretOnly(action, focused) ? CARET_CHANGE_WAIT_MS : changeWaitMs;
}

/**
 * The settle policy per action kind. A `tool` entry is a gap: replay stops
 * at it, so its `look` is never taken, while the live loop arms its change
 * wait after every mutating project tool.
 */
export const SETTLE_AFTER: Record<RecordedAction['name'], SettleAfter> = {
  tap: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  doubleTap: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  longPress: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  secondaryTap: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  hover: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  type: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'after-change' },
  typeSecret: { look: 'held-still' },
  press: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  select: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  check: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  drag: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  upload: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  scroll: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
  // Scrolling a node into view moves nothing the tree records, like a scroll.
  scrollTo: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
  // A list paged to a row settles between its pages; the last page is a scroll.
  scrollUntil: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
  navigate: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  back: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  // A layout may reflow at the new size or stay as it was, like a scroll.
  resize: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
  // Another tab is another document, shown whole the moment it is switched to.
  switchTab: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  // Closing the tab on screen shows another document, as a switch does.
  closeTab: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  tapAt: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  hoverAt: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  dragAt: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  typeText: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'after-change' },
  pressKey: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  dismissKeyboard: { changeWaitMs: FULL_CHANGE_WAIT_MS, look: 'held-still' },
  tool: { changeWaitMs: BRIEF_CHANGE_WAIT_MS, look: 'held-still' },
};
