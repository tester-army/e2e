/**
 * Text on its way into markdown: escaped, clipped, one line. Shared by the
 * run page (`markdown.ts`) and the per-failure pages (`failure-page.ts`),
 * so both treat what a test wrote the same way.
 */

import { collapseText } from '../internal/text.ts';
import { ellipsize } from './format.ts';

/** Text widths, in code points. */
export const MAX_CELL_CHARS = 240;
export const MAX_PATH_CHARS = 200;
export const MAX_TITLE_CHARS = 120;
export const MAX_ID_CHARS = 64;
export const MAX_LABEL_CHARS = 60;

/**
 * Text safe inside a table cell or a list item: one line, clipped by code
 * point so an emoji at the cut survives whole, markdown that could open a
 * construct escaped, angle brackets as entities so no HTML gets through, and
 * the cell separator escaped. An underscore stays: inside a word GitHub
 * never reads it as emphasis, and error codes are full of them.
 */
export function cell(text: string, max = MAX_CELL_CHARS): string {
  return ellipsize(collapseText(text), max)
    .replace(/[\\`*[\]~|]/g, (char) => `\\${char}`)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** A path or label inside backticks: only the backtick and the cell separator have to go. */
export function code(text: string, max = MAX_CELL_CHARS): string {
  return `\`${ellipsize(collapseText(text), max).replaceAll('`', '').replaceAll('|', '\\|')}\``;
}

/**
 * A URL inside a markdown link destination. The caller chose it, but a
 * character that closes the destination or breaks it must not get through
 * to the rendered page, so those are percent-encoded.
 */
function href(url: string): string {
  return collapseText(url).replace(/[\s()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function link(text: string, url: string): string {
  return `[${text}](${href(url)})`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  // Round to whole seconds first, so 119.5 s is 2m 0s and never 1m 60s.
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
