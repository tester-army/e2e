/**
 * Spellings the deterministic suite shares: reading a code off the page, the
 * centre of a node, the error a step failed with, and the control beside a
 * visible label.
 */

import type { Web } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Locator, Point } from 'e2e';

/**
 * Waits until `target` shows `pattern`, then returns the match, the way a
 * person copies a code off the screen.
 */
export async function readCode(target: Locator, pattern: RegExp): Promise<string> {
  await expect(target).toContainText(pattern);
  const code = (await target.textContent())?.match(pattern)?.[0];
  if (code === undefined) throw new Error(`the text no longer matches ${pattern}`);
  return code;
}

/** The centre of a node's box, the point a pixel-driven gesture aims for; no box is an error. */
export async function centerOf(node: Locator): Promise<Point> {
  const box = await node.boundingBox();
  if (box === null) throw new Error('the node has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** What `act` threw or rejected with, undefined when it succeeded; the caller pins its `code`. */
export async function failure(act: () => unknown): Promise<unknown> {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * The first `sibling` element after the node whose own text is `label`: a
 * Screen query names a node by its own text or accessible name and cannot
 * step to a neighbour, so a control whose only truthful name is the label
 * text beside it has no semantic handle.
 */
export function siblingOf(web: Web, label: string, sibling: string): Locator {
  return web.locator(
    `xpath=//*[normalize-space(text())=${xpathLiteral(label)}]/following-sibling::${sibling}[1]`,
  );
}

/** Quotes `text` as an XPath string literal, through `concat()` when it holds both quote kinds. */
function xpathLiteral(text: string): string {
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  return `concat("${text.split('"').join(`", '"', "`)}")`;
}
