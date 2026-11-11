/**
 * Hides the text caret for the duration of a screenshot without touching the
 * `style` attribute of an editable element.
 *
 * Playwright's `caret: 'hide'` writes an inline `caret-color` on every
 * editable element and restores it after the frame, so a framework hydrating
 * at that moment reads the written style as a server mismatch. A constructed
 * stylesheet changes no element's style, and unlike a `<style>` element it is
 * not blocked by a `style-src` policy.
 */

import { withTimeout } from 'e2e/engine';
import type { Frame, JSHandle, Page } from 'playwright-core';

/** The most one frame may hold the capture while taking or giving back the sheet. */
const FRAME_BUDGET_MS = 1_000;

/**
 * Runs in the page. Adopts the caret stylesheet into the frame's document and
 * every shadow root below it, open or closed, and returns the function that
 * takes it back. Closed roots are reached through the record the init script
 * keeps, since nothing else can name them.
 */
function hideCaret(): () => void {
  const closed: WeakMap<Element, ShadowRoot> | undefined = Reflect.get(globalThis, Symbol.for('e2e.closedShadowRoots'));
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('input, textarea, [contenteditable] { caret-color: transparent !important; }');
  const roots: (Document | ShadowRoot)[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    roots.push(root);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot ?? closed?.get(element);
      if (shadow !== null && shadow !== undefined) visit(shadow);
    }
  };
  visit(document);
  return () => {
    for (const root of roots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((other) => other !== sheet);
  };
}

/** Best effort: a frame that stalls or navigated away must not hold the capture. */
async function inFrame<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await withTimeout(work, FRAME_BUDGET_MS, () => new Error('screenshot caret stylesheet timed out'));
  } catch {
    return undefined;
  }
}

/**
 * Adopts the sheet in one frame. The evaluate cannot be cancelled, so one that
 * lands after the budget has its undo handle run at once: a late setup result
 * must not leave the sheet adopted and the caret hidden.
 */
async function adoptInFrame(frame: Frame): Promise<JSHandle<() => void> | undefined> {
  const work = frame.evaluateHandle(hideCaret);
  const undo = await inFrame(work);
  if (undo !== undefined) return undo;
  void work
    .then((late) => late.evaluate((show) => show()).then(() => late.dispose()))
    .catch(() => undefined);
  return undefined;
}

/**
 * Runs `capture` with the caret stylesheet adopted in every frame, and takes
 * it back afterwards whatever the capture does.
 */
export async function withHiddenCaret<T>(page: Page, capture: () => Promise<T>): Promise<T> {
  const undos = await Promise.all(page.frames().map(adoptInFrame));
  try {
    return await capture();
  } finally {
    await Promise.all(
      undos.map(async (undo) => {
        if (undo === undefined) return;
        await inFrame(undo.evaluate((show) => show()).finally(() => undo.dispose()));
      }),
    );
  }
}
