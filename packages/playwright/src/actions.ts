/** Locator action dispatch for the Playwright backend. */

import { BackendError, type LocatorAction, type NodeRef } from 'e2e/backend';
import {
  asActionable,
  isClassified,
  isPwTimeout,
  message,
  performElementSwipe,
  performPointerDrag,
  type ActionTarget,
} from './support.ts';

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
      await locator.click({ timeout });
      return;
    case 'doubleTap':
      await locator.dblclick({ timeout });
      return;
    case 'longPress':
      await locator.click({ timeout, delay: action.durationMs ?? 500 });
      return;
    case 'fill':
      await locator.fill(action.value, { timeout });
      return;
    case 'clear':
      await locator.fill('', { timeout });
      return;
    case 'press':
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
    case 'swipe': {
      await performElementSwipe(target, action.direction, action.momentum ?? 'none', timeout);
      return;
    }
  }
}

/** Classifies a failed action onto the error contract: stale, not actionable, or a backend fault. */
export function classifyActionError(cause: unknown, action: LocatorAction): BackendError {
  if (isClassified(cause)) return cause as BackendError;
  const text = message(cause);
  if (/strict mode violation/i.test(text)) {
    return new BackendError('BACKEND_FAILURE', text, { retryable: false, cause });
  }
  if (/element (is |was )?(detached|not attached)/i.test(text)) {
    return new BackendError('NODE_STALE', text, { retryable: true, cause });
  }
  if (/Timeout .*exceeded/i.test(text) || isPwTimeout(cause)) {
    return new BackendError(
      'NOT_ACTIONABLE',
      `${action.kind} did not become actionable in time: ${text}`,
      { retryable: false, cause },
    );
  }
  if (/not an? <?(input|checkbox|radio|select)|not editable|not checkable/i.test(text)) {
    return new BackendError('NOT_ACTIONABLE', text, { retryable: false, cause });
  }
  return new BackendError('BACKEND_FAILURE', text, { retryable: false, cause });
}
