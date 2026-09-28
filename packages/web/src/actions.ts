/** Locator action dispatch for the Playwright engine. */

import type { Page } from 'playwright';
import { EngineError, type KeyModifier, type LocatorAction, type NodeRef, type PointerAction, type ViewportPoint } from 'e2e/engine';
import {
  asActionable,
  isClassified,
  isPwTimeout,
  message,
  nearestPixel,
  performElementSwipe,
  performPointDrag,
  performPointerDrag,
  performViewportSwipe,
  POST_DISPATCH_PATTERN,
  type ActionTarget,
} from './support.ts';

/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;

/** The keys a click holds, as Playwright's `modifiers` takes them; the contract spells them the same. */
function heldKeys(action: Extract<LocatorAction, { kind: 'tap' | 'doubleTap' | 'secondaryTap' }>): { modifiers?: KeyModifier[] } {
  return action.modifiers === undefined ? {} : { modifiers: [...action.modifiers] };
}

/**
 * Dispatches one deterministic locator action onto a Playwright target with the
 * platform's own actionability checks. `lookup` resolves the second ref of a
 * drag; everything else needs only the target.
 */
export async function dispatchLocatorAction(
  target: ActionTarget,
  action: LocatorAction,
  timeout: number,
  lookup: (ref: NodeRef) => ActionTarget,
): Promise<void> {
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
      await locator.check({ timeout });
      return;
    case 'uncheck':
      await locator.uncheck({ timeout });
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
export async function dispatchPointerAction(page: Page, at: ViewportPoint, action: PointerAction): Promise<void> {
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
    case 'swipeTo':
      // A swipe along a path is a pointer drag on a document platform.
      await performPointDrag(mouse, point, action.target);
      return;
    case 'swipe':
      // The pointer moves to the point first so the scrollable under it receives the wheel.
      await mouse.move(point.x, point.y);
      await performViewportSwipe(page, action.direction, action.momentum ?? 'none');
      return;
  }
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
 * committed, or an engine fault.
 */
export function classifyActionError(rawCause: unknown, action: LocatorAction): Error {
  if (isClassified(rawCause)) return rawCause;
  const text = redactSensitive(message(rawCause), action);
  const cause = isSensitive(action) ? undefined : rawCause;
  if (/strict mode violation/i.test(text)) {
    return new EngineError('ENGINE_FAILURE', text, { retryable: false, cause });
  }
  if (/element (is |was )?(detached|not attached)/i.test(text)) {
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
