/**
 * Hides the text caret for the duration of a screenshot without touching the
 * `style` attribute of an editable element.
 *
 * Playwright's `caret: 'hide'` writes an inline `caret-color` on every
 * `input`, `textarea`, and `[contenteditable]` and restores it after the
 * frame, so a framework hydrating at that moment reads the written style as a
 * server mismatch. A constructed stylesheet changes no element's style, and
 * unlike a `<style>` element it is not blocked by a `style-src` policy.
 */

import { randomUUID } from 'node:crypto';
import { withTimeout } from 'e2e/engine';
import type { Page } from 'playwright-core';

/** The rule Playwright's `caret: 'hide'` applied inline. */
export const CARET_STYLESHEET = 'input, textarea, [contenteditable] { caret-color: transparent !important; }';

/** The global key an adoption parks its sheets under until removal. */
const TOKEN_PREFIX = 'e2e.caretStylesheet.';

/** Removal gets its own budget: the capture may have spent the operation's deadline. */
const REMOVE_BUDGET_MS = 1_000;

interface Adoption {
  readonly source: string;
  readonly token: string;
}

interface ParkedSheet {
  readonly root: Document | ShadowRoot;
  readonly sheet: CSSStyleSheet;
}

/**
 * Runs in the page. Adopts the stylesheet into the document, every open shadow
 * root, and every closed shadow root the init script recorded, and returns how
 * many roots took it. The sheets are parked under `token` for removal.
 */
export function adoptCaretStylesheet({ source, token }: Adoption): number {
  const tracker: unknown = Reflect.get(globalThis, Symbol.for('e2e.closedShadowRoots'));
  const roots: (Document | ShadowRoot)[] = [];
  const seen = new Set<Document | ShadowRoot>();
  const visit = (root: Document | ShadowRoot): void => {
    if (seen.has(root)) return;
    seen.add(root);
    roots.push(root);
    for (const element of root.querySelectorAll('*')) {
      const open = element.shadowRoot;
      if (open !== null) visit(open);
      const closed = tracker instanceof WeakMap ? tracker.get(element) : undefined;
      if (closed instanceof ShadowRoot) visit(closed);
    }
  };
  visit(document);
  const parked: ParkedSheet[] = [];
  for (const root of roots) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(source);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      parked.push({ root, sheet });
    } catch {
      // A root that refuses the sheet keeps its caret; the capture still runs.
    }
  }
  Reflect.set(globalThis, token, parked);
  return parked.length;
}

/**
 * Runs in the page. Takes back every sheet `adoptCaretStylesheet` adopted
 * under `token`, leaving each root's own style sheets as they were.
 */
export function removeCaretStylesheet(token: string): void {
  const parked: unknown = Reflect.get(globalThis, token);
  if (!Array.isArray(parked)) return;
  Reflect.deleteProperty(globalThis, token);
  for (const entry of parked) {
    if (typeof entry !== 'object' || entry === null) continue;
    const root: unknown = Reflect.get(entry, 'root');
    const sheet: unknown = Reflect.get(entry, 'sheet');
    if ((root instanceof Document || root instanceof ShadowRoot) && sheet instanceof CSSStyleSheet) {
      try {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter((current) => current !== sheet);
      } catch {
        // A root gone with its document has nothing left to restore.
      }
    }
  }
}

/**
 * Runs `capture` with the caret stylesheet adopted in every frame and removes
 * it afterwards whatever the capture does. A frame that cannot take the sheet
 * is skipped: hiding the caret is cosmetic, and the screenshot must still run.
 */
export async function withHiddenCaret<T>(page: Page, budgetMs: number, capture: () => Promise<T>): Promise<T> {
  const token = `${TOKEN_PREFIX}${randomUUID()}`;
  const frames = page.frames();
  const step = Math.max(1, Math.min(budgetMs, 1_000));
  await Promise.all(
    frames.map(async (frame) => {
      try {
        await withTimeout(
          frame.evaluate(adoptCaretStylesheet, { source: CARET_STYLESHEET, token }),
          step,
          () => new Error('screenshot caret stylesheet timed out'),
        );
      } catch {
        // The frame keeps its caret; the capture still matters.
      }
    }),
  );
  try {
    return await capture();
  } finally {
    await Promise.all(
      frames.map(async (frame) => {
        try {
          await withTimeout(
            frame.evaluate(removeCaretStylesheet, token),
            REMOVE_BUDGET_MS,
            () => new Error('screenshot caret stylesheet timed out'),
          );
        } catch {
          // A frame that navigated away took its sheets with it.
        }
      }),
    );
  }
}
