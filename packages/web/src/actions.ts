/** Locator action dispatch for the Playwright engine. */

import type { ElementHandle, Page } from 'playwright-core';
import { Deadline, EngineError, pollCondition, type KeyModifier, type LocatorAction, type NodeRef, type PointerAction, type ViewportPoint } from 'e2e/engine';
import {
  asActionable,
  isClassified,
  isNavigationRace,
  isPwTimeout,
  message,
  nearestPixel,
  performElementSwipe,
  performPointDrag,
  performPointerDrag,
  performViewportSwipe,
  POST_DISPATCH_PATTERN,
  translatePwError,
  type ActionTarget,
} from './support.ts';
import type { ConnectionBudget } from './operation-budget.ts';

/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;

/** The keys a click holds, as Playwright's `modifiers` takes them; the contract spells them the same. */
function heldKeys(action: Extract<LocatorAction, { kind: 'tap' | 'doubleTap' | 'secondaryTap' }>): { modifiers?: KeyModifier[] } {
  return action.modifiers === undefined ? {} : { modifiers: [...action.modifiers] };
}

/** Playwright's words for an element handle whose element left the DOM. */
const DETACHED_PATTERN = /element (is |was )?(detached|not attached)/i;

/**
 * Sets a checkbox, switch, or radio to `checked` with one click, as
 * Playwright's `check` does, apart from the reads after the click. Playwright
 * reads the state once; here it is polled until the operation's deadline, so
 * a control that commits its new state after an await or a timer passes, and
 * one that never changes fails at the deadline. A control that is gone by
 * the first read (an app that swaps a picked radio for its selected view, or
 * navigates on change) took the click, so the action is done, where
 * Playwright reports it detached as if the click never happened. One that
 * goes later, still in its old state, may have been replaced for any reason,
 * so it fails rather than passing on a click the app rejected. Whatever took
 * its place is not read: the next observation or assertion shows it, as it
 * does after a tap.
 * The reads and the click share one element, so the state before and after
 * the click is one control's.
 */
async function setChecked(target: ActionTarget, checked: boolean, operation: ConnectionBudget): Promise<void> {
  const deadline = new Deadline(operation.timeoutMs);
  // Playwright reads a timeout of 0 as no timeout at all.
  const remaining = (): number => Math.max(1, deadline.remaining());
  const element =
    target.kind === 'element' ? target.element : await target.locator.elementHandle({ timeout: operation.timeoutMs });
  const verb = checked ? 'check' : 'uncheck';
  try {
    if ((await element.isChecked()) === checked) return;
    if (!checked && (await isRadio(element))) {
      throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', {
        retryable: false,
      });
    }
    await element.click({ timeout: remaining() });
    const unchanged = (detail = ''): EngineError =>
      new EngineError('NOT_ACTIONABLE', `${verb} clicked the control but its checked state did not change${detail}`, {
        retryable: false,
      });
    let firstRead = true;
    await pollCondition({
      deadline,
      signal: operation.signal,
      negated: false,
      evaluate: async () => {
        const first = firstRead;
        firstRead = false;
        try {
          return (await element.isChecked()) === checked;
        } catch (cause) {
          if (!DETACHED_PATTERN.test(message(cause)) && !isNavigationRace(cause)) throw cause;
          if (first) return true;
          throw unchanged(' before the control was replaced');
        }
      },
      onTimeout: () => unchanged(),
    });
  } finally {
    if (target.kind === 'locator') void element.dispose().catch(() => undefined);
  }
}

/** Whether a checkable element is a radio, which a click can select but never clear. */
function isRadio(element: ElementHandle<Element>): Promise<boolean> {
  return element.evaluate(
    (node) => (node instanceof HTMLInputElement && node.type === 'radio') || node.getAttribute('role') === 'radio',
  );
}

/**
 * Dispatches one deterministic locator action onto a Playwright target with the
 * platform's own actionability checks. `lookup` resolves the second ref of a
 * drag; everything else needs only the target.
 */
export async function dispatchLocatorAction(
  target: ActionTarget,
  action: LocatorAction,
  operation: ConnectionBudget,
  lookup: (ref: NodeRef) => ActionTarget,
): Promise<void> {
  const timeout = operation.timeoutMs;
  const locator = asActionable(target);
  switch (action.kind) {
    case 'tap':
      await locator.click({ timeout, ...heldKeys(action) });
      return;
    case 'doubleTap':
      await locator.dblclick({ timeout, ...heldKeys(action) });
      return;
    case 'secondaryTap':
      await locator.click({ button: 'right', timeout, ...heldKeys(action) });
      return;
    case 'longPress':
      await locator.click({ timeout, delay: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
      return;
    case 'fill':
      await locator.fill(action.value, { timeout });
      return;
    case 'clear':
      await locator.fill('', { timeout });
      return;
    case 'press':
      // Playwright spells keys as the contract grammar does; the harness has
      // already refused anything outside it, so the key is pressed as given.
      await locator.press(action.key, { timeout });
      return;
    case 'check':
    case 'uncheck':
      await setChecked(target, action.kind === 'check', operation);
      return;
    case 'focus':
      // ElementHandle.focus takes no timeout: the element is already resolved.
      if (target.kind === 'locator') await target.locator.focus({ timeout });
      else await target.element.focus();
      return;
    case 'hover':
      await locator.hover({ timeout });
      return;
    case 'scrollIntoView':
      await locator.scrollIntoViewIfNeeded({ timeout });
      return;
    case 'selectOption': {
      const value = action.value;
      if (typeof value === 'string') {
        await locator.selectOption({ label: value }, { timeout });
      } else if (value.index !== undefined) {
        await locator.selectOption({ index: value.index }, { timeout });
      } else if (value.value !== undefined) {
        await locator.selectOption({ value: value.value }, { timeout });
      } else {
        await locator.selectOption({ label: value.label }, { timeout });
      }
      return;
    }
    case 'setInputFiles':
      await locator.setInputFiles([...action.paths], { timeout });
      return;
    case 'dragTo': {
      const other = lookup(action.target);
      // Playwright's own drag when both sides are locators: it waits for
      // actionability on each and reports better failures than a pointer
      // sequence can. Anything else - an observed reference on either side -
      // is dragged with the pointer.
      if (target.kind === 'locator' && other.kind === 'locator') {
        await target.locator.dragTo(other.locator, { timeout });
      } else {
        await performPointerDrag(target, other, timeout);
      }
      return;
    }
    case 'swipe':
      // The agent's node scroll and `screen` swipes both arrive here: a wheel
      // gesture over the node, sized by its own box.
      await performElementSwipe(target, action.direction, action.momentum ?? 'none', timeout);
      return;
  }
}

/**
 * Dispatches one pointer action at a viewport point with nothing resolved
 * behind it: no actionability wait, because there is no element to wait on,
 * and the page decides what the gesture lands on, as it does for a person.
 */
export async function dispatchPointerAction(
  page: Page,
  at: ViewportPoint,
  action: PointerAction,
  signal?: AbortSignal,
): Promise<void> {
  const { mouse } = page;
  const point = nearestPixel(at);
  switch (action.kind) {
    case 'tap':
      await mouse.click(point.x, point.y);
      return;
    case 'doubleTap':
      await mouse.dblclick(point.x, point.y);
      return;
    case 'secondaryTap':
      await mouse.click(point.x, point.y, { button: 'right' });
      return;
    case 'longPress':
      await mouse.click(point.x, point.y, { delay: action.durationMs ?? DEFAULT_LONG_PRESS_MS });
      return;
    case 'hover':
      await mouse.move(point.x, point.y);
      return;
    case 'dragTo':
      await performPointDrag(mouse, point, action.target, undefined, signal);
      return;
    case 'swipeTo':
      // A swipe along a path is a pointer drag on a document platform.
      await performPointDrag(mouse, point, action.target, action.durationMs, signal);
      return;
    case 'swipe':
      // The pointer moves to the point first so the scrollable under it receives the wheel.
      await mouse.move(point.x, point.y);
      await performViewportSwipe(page, action.direction, action.momentum ?? 'none');
      return;
  }
}

/**
 * An input operation the operation deadline cut off: Playwright never
 * answered, so whether the input reached the page is unknown, and it must not
 * be repeated blindly.
 */
function inputCutOff(cause: unknown, label: string): EngineError | undefined {
  if (!(cause instanceof EngineError) || cause.code !== 'OPERATION_TIMEOUT') return undefined;
  return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label} timed out before the page answered; its input may have been dispatched`, {
    retryable: false,
    cause,
  });
}

/** Translates the failure of an input operation with no element behind it: a pointer action at a point, or a keystroke. */
export function classifyInputError(cause: unknown, label: string): Error {
  return inputCutOff(cause, label) ?? translatePwError(cause, label);
}

/**
 * Whether a failure of this action may carry the value it was given. A
 * sensitive fill's plaintext must never leave the engine: its message is
 * scrubbed and the raw Playwright error - whose stack the report would
 * otherwise print - is not attached as a cause.
 */
function isSensitive(action: LocatorAction): action is LocatorAction & { kind: 'fill'; sensitive: true } {
  return action.kind === 'fill' && action.sensitive;
}

/** Scrubs a sensitive fill value out of text that is about to leave the engine. */
function redactSensitive(text: string, action: LocatorAction): string {
  if (!isSensitive(action) || action.value.length === 0) return text;
  return text.replaceAll(action.value, '[redacted]');
}

/** A call-log line naming what kept a node from being acted on: an element over it, or a state it never reached. */
const BLOCKER_PATTERN = /^element is (?:not (?:visible|enabled|stable|editable)|outside of the viewport)$| intercepts pointer events$/i;

/**
 * Playwright's timeout cut to its headline and the last blocker its call log
 * names: `<div data-popover>… intercepts pointer events` says what to close,
 * where the whole log repeats it once per retry, thousands of characters a
 * report prints and the agent pays for as model input. A log without a
 * blocker is kept whole.
 */
function actionabilitySummary(text: string): string {
  const [headline = text, ...log] = text.split('\n');
  const blocker = log
    .map((line) => line.trim().replace(/^- /, ''))
    .findLast((line) => BLOCKER_PATTERN.test(line));
  return blocker === undefined ? text : `${headline} ${blocker}`;
}

/**
 * Classifies a failed action onto the error contract (see the table above
 * `POST_DISPATCH_PATTERN` in support.ts): stale, not actionable, possibly
 * committed, or an engine fault. A strict mode violation is a located match
 * that turned ambiguous: stale like a detached one before any input, so the
 * runner locates again and reports the ambiguity or acts on the one match
 * left; possibly committed once input went out, as the second side of a drag
 * resolves after the press.
 */
export function classifyActionError(rawCause: unknown, action: LocatorAction): Error {
  const cut = inputCutOff(rawCause, action.kind);
  if (cut !== undefined) return cut;
  if (isClassified(rawCause)) return rawCause;
  const text = redactSensitive(message(rawCause), action);
  const cause = isSensitive(action) ? undefined : rawCause;
  if (/strict mode violation/i.test(text)) {
    if (POST_DISPATCH_PATTERN.test(text)) {
      return new EngineError(
        'ACTION_MAY_HAVE_COMMITTED',
        `${action.kind} matched more than one element after its input was dispatched: ${text}`,
        { retryable: false, cause },
      );
    }
    return new EngineError('NODE_STALE', text, { retryable: true, cause });
  }
  if (DETACHED_PATTERN.test(text)) {
    return new EngineError('NODE_STALE', text, { retryable: true, cause });
  }
  if (/Timeout .*exceeded/i.test(text) || isPwTimeout(rawCause)) {
    if (POST_DISPATCH_PATTERN.test(text)) {
      return new EngineError(
        'ACTION_MAY_HAVE_COMMITTED',
        `${action.kind} timed out after its input was dispatched: ${text}`,
        { retryable: false, cause },
      );
    }
    return new EngineError(
      'NOT_ACTIONABLE',
      `${action.kind} did not become actionable in time: ${actionabilitySummary(text)}`,
      { retryable: false, cause },
    );
  }
  if (/not an? <?(input|checkbox|radio|select)|not editable|not checkable/i.test(text)) {
    return new EngineError('NOT_ACTIONABLE', text, { retryable: false, cause });
  }
  return new EngineError('ENGINE_FAILURE', text, { retryable: false, cause });
}
