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
 * A token GitHub turns into a link on its own: a mention or an email address
 * (`@` before a letter or digit), an issue reference (`#` or `GH-` before a
 * digit), a URL with a scheme, or a `www.` host. Entities and backslashes do
 * not stop the mention and issue filters, which run on the rendered text; a
 * code span does, and it also stops the URL autolinks.
 */
const LINKABLE_TOKEN = /@[A-Za-z0-9]|#\d|\bGH-\d|:\/\/|\bwww\./i;

/**
 * What opens a block construct at the start of a line: an ordered list
 * marker, or the first character of a heading, a list item, a thematic break,
 * or a setext underline.
 */
const BLOCK_OPENER = /^(\d{1,9})([.)])(?=\s|$)|^[#+=_-]/;

/**
 * Text safe inside a table cell, a list item, or at the start of a line: one
 * line, clipped by code point so an emoji at the cut survives whole, markdown
 * that could open a construct escaped, angle brackets as entities so no HTML
 * gets through, and the cell separator escaped. A token GitHub would link on
 * its own (a mention, an issue number, a URL) is shown as code, the one
 * rendering GitHub's autolink filters leave alone, so screen text from the
 * app under test cannot notify anyone or plant a link in a pull request
 * comment. An underscore stays: inside a word GitHub never reads it as
 * emphasis, and error codes are full of them.
 */
export function cell(text: string, max = MAX_CELL_CHARS): string {
  const line = ellipsize(collapseText(text), max)
    .split(' ')
    .map((token) => (LINKABLE_TOKEN.test(token) ? codeSpan(token) : escapeInline(token)))
    .join(' ');
  return line.replace(BLOCK_OPENER, (opener, digits: string | undefined, mark: string | undefined) =>
    digits === undefined ? `\\${opener}` : `${digits}\\${mark}`,
  );
}

/** Inline markdown a token could open, escaped; angle brackets become entities. */
function escapeInline(text: string): string {
  return text
    .replace(/[\\`*[\]~|]/g, (char) => `\\${char}`)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** A code span: a backtick cannot be escaped inside one, so it goes; the cell separator is escaped, which GFM honours inside a span. */
function codeSpan(text: string): string {
  return `\`${text.replaceAll('`', '').replaceAll('|', '\\|')}\``;
}

/** A path or label inside backticks: only the backtick and the cell separator have to go. */
export function code(text: string, max = MAX_CELL_CHARS): string {
  return codeSpan(ellipsize(collapseText(text), max));
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
