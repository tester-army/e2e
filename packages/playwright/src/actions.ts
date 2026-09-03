/** Locator action dispatch for the Playwright backend. */

import { BackendError, type LocatorAction, type NodeRef } from 'e2e/backend';
import {
  type Actionable,
  asActionable,
  isClassified,
  isPwTimeout,
  message,
  performElementSwipe,
  performPointerDrag,
  POST_DISPATCH_PATTERN,
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
        await locator.selectOption({ label: await resolveOptionLabel(locator, value) }, { timeout });
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
    case 'swipe':
      // The agent's node scroll and `screen` swipes both arrive here: a wheel
      // gesture over the node, sized by its own box.
      await performElementSwipe(target, action.direction, action.momentum ?? 'none', timeout);
      return;
  }
}

/**
 * Whether a failure of this action may carry the value it was given. A
 * sensitive fill's plaintext must never leave the backend: its message is
 * scrubbed and the raw Playwright error - whose stack the report would
 * otherwise print - is not attached as a cause.
 */
function isSensitive(action: LocatorAction): action is LocatorAction & { kind: 'fill'; sensitive: true } {
  return action.kind === 'fill' && action.sensitive;
}

/** Scrubs a sensitive fill value out of text that is about to leave the backend. */
function redactSensitive(text: string, action: LocatorAction): string {
  if (!isSensitive(action) || action.value.length === 0) return text;
  return text.replaceAll(action.value, '[redacted]');
}

/**
 * Classifies a failed action onto the error contract (see the table above
 * `POST_DISPATCH_PATTERN` in support.ts): stale, not actionable, possibly
 * committed, or a backend fault.
 */
export function classifyActionError(rawCause: unknown, action: LocatorAction): Error {
  if (isClassified(rawCause)) return rawCause;
  const text = redactSensitive(message(rawCause), action);
  const cause = isSensitive(action) ? undefined : rawCause;
  if (/strict mode violation/i.test(text)) {
    return new BackendError('BACKEND_FAILURE', text, { retryable: false, cause });
  }
  if (/element (is |was )?(detached|not attached)/i.test(text)) {
    return new BackendError('NODE_STALE', text, { retryable: true, cause });
  }
  if (/Timeout .*exceeded/i.test(text) || isPwTimeout(rawCause)) {
    if (POST_DISPATCH_PATTERN.test(text)) {
      return new BackendError(
        'ACTION_MAY_HAVE_COMMITTED',
        `${action.kind} timed out after its input was dispatched: ${text}`,
        { retryable: false, cause },
      );
    }
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

/**
 * The option label to select for a label the caller named. An exact label
 * wins; otherwise the one option whose label matches case-insensitively, then
 * the one it prefixes, then the one that contains it. A model reads
 * `option "A4 copy paper 80g (NP-A4-80)"` and asks for "A4 copy paper 80g";
 * refusing that on punctuation buys a failed action and a keyboard fallback,
 * not safety — an ambiguous match is still refused, and a control that is not
 * a `<select>` keeps the label as given.
 */
async function resolveOptionLabel(locator: Actionable, label: string): Promise<string> {
  let labels: string[] | null = null;
  try {
    labels = await locator.evaluate((element: Element): string[] | null =>
      element instanceof HTMLSelectElement
        ? Array.from(element.options).map((option) => option.label || option.text)
        : null,
    );
  } catch {
    labels = null;
  }
  if (!Array.isArray(labels) || labels.includes(label)) return label;
  const wanted = label.trim().toLowerCase();
  const unique = (test: (candidate: string) => boolean): string | undefined => {
    const hits = labels.filter((candidate) => test(candidate.trim().toLowerCase()));
    return hits.length === 1 ? hits[0] : undefined;
  };
  return (
    unique((candidate) => candidate === wanted) ??
    unique((candidate) => candidate.startsWith(wanted)) ??
    unique((candidate) => candidate.includes(wanted)) ??
    label
  );
}
