/**
 * Reading a screen for a text the agent pages toward: which node reads it,
 * and what the screen reads as a whole, for telling a page that moved from
 * one that did not. A module of its own so the rules are tested as rules.
 */

import type { SemanticNode } from '../engine/surface.ts';
import { maskClocks, type SemanticAgentObservation } from './observation.ts';

/** A reading for matching: lower-cased, whitespace runs collapsed, trimmed. */
export function normalizeReading(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * How much longer than the text a label may run and still be the node that
 * reads it: a row label with a suffix ("Row 4322 - Golden Row"), never the
 * sentence that mentions the row ("Scroll to Row 0512 and tap it"), which
 * would end the paging on the very screen that gives the instruction.
 */
const READING_SLACK = 24;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whether a normalized label reads the text: as its whole, or with nothing
 * of a word on either side of it. "Row 12" reads "Row 12 - Golden" and never
 * "Row 120", which shares its prefix and comes first in many a list.
 */
function reads(reading: string, needle: string): boolean {
  if (reading === needle) return true;
  for (let at = reading.indexOf(needle); at !== -1; at = reading.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : reading.charAt(at - 1);
    const after = reading.charAt(at + needle.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}

function* descendants(node: SemanticNode): Generator<SemanticNode> {
  for (const child of node.children ?? []) {
    yield child;
    yield* descendants(child);
  }
}

/**
 * The visible node whose name or text reads `needle` (already normalized):
 * the label is the text, or holds it whole within a label not much longer
 * (`READING_SLACK`, or three times the text). The shortest such label wins,
 * since a device echoes a row's text up into its container and the row
 * itself is the node to reach. With a `scope`, the list being paged, only
 * its descendants count: a heading or a hint elsewhere that reads the same
 * would end the paging before the list moved.
 */
export function nodeReading(
  observation: Pick<SemanticAgentObservation, 'nodes'>,
  needle: string,
  scope?: SemanticNode,
): SemanticNode | undefined {
  const longest = Math.max(needle.length * 3, needle.length + READING_SLACK);
  let best: { node: SemanticNode; length: number } | undefined;
  for (const node of scope === undefined ? observation.nodes.values() : descendants(scope)) {
    if (node.states?.hidden === true) continue;
    for (const label of [node.name, node.text]) {
      if (label === undefined) continue;
      const reading = normalizeReading(label);
      if (reading.length > longest || !reads(reading, needle)) continue;
      if (best === undefined || reading.length < best.length) best = { node, length: reading.length };
    }
  }
  return best?.node;
}

/** One node of a page: what it reads with clock-like values masked, and as it is. */
interface PageLine {
  readonly masked: string;
  readonly exact: string;
}

/** What a screen reads, a line per node that carries a name or text. */
export interface PageReading {
  readonly lines: readonly PageLine[];
}

/**
 * What a screen reads and where, for telling a page that moved from one that
 * did not. Name and text both count: a windowed list's rows keep one name
 * and one slot on the screen while the text in them changes, and that is the
 * list moving. Each line is kept masked and as it is, since a clock-like
 * value is both a clock ticking and a time picker's row.
 */
export function readPage(observation: Pick<SemanticAgentObservation, 'nodes'>): PageReading {
  const lines: PageLine[] = [];
  for (const node of observation.nodes.values()) {
    if (node.name === undefined && node.text === undefined) continue;
    const at = node.rect === undefined ? '' : `${String(Math.round(node.rect.x))},${String(Math.round(node.rect.y))}`;
    const exact = `${node.name ?? ''}|${node.text ?? ''}@${at}`;
    lines.push({ masked: maskClocks(exact), exact });
  }
  return { lines };
}

/** Whether two pages read the same lines, clock-like values masked. */
function sameLines(before: PageReading, after: PageReading): boolean {
  return before.lines.length === after.lines.length && before.lines.every((line, at) => line.masked === after.lines[at]?.masked);
}

/**
 * How many clock-like values changing at once are a list turning over and
 * not clocks ticking: one clock ticks beside a screen, while a time picker or
 * a timetable changes every row it shows. Several clocks ticking together
 * (world clocks) read as a list that moves, which only costs the end-of-list
 * check its early exit, as before.
 */
const TURNOVER_CLOCKS = 2;

/**
 * Whether the screen moved between two looks, for ending a scroll at the end
 * of its list. A different set of lines is a page that moved, whatever
 * clock-like values read. When only those differ, one changing is a clock
 * ticking beside a list that has not moved, and several are the list's own
 * rows (a time picker, a timetable) turning over.
 */
export function pageMoved(before: PageReading, after: PageReading): boolean {
  if (!sameLines(before, after)) return true;
  let ticked = 0;
  for (const [at, line] of before.lines.entries()) if (line.exact !== after.lines[at]?.exact) ticked += 1;
  return ticked >= TURNOVER_CLOCKS;
}

/**
 * The share of a page's lines that must be new for a swipe to have turned it.
 * A page turn replaces most of the rows it shows; a counter or a status line
 * beside a stale list replaces a line or two. A third leaves room for chrome
 * as large as the list itself, and a page with more takes the look that
 * proves it holds still, which only costs the read this saves.
 */
const LANDED_NEW_SHARE = 1 / 3;

/** How many lines of `after` the page before did not read, clock-like values masked. */
function newLines(before: PageReading, after: PageReading): number {
  const unmatched = new Map<string, number>();
  for (const line of before.lines) unmatched.set(line.masked, (unmatched.get(line.masked) ?? 0) + 1);
  let fresh = 0;
  for (const line of after.lines) {
    const left = unmatched.get(line.masked) ?? 0;
    if (left > 0) unmatched.set(line.masked, left - 1);
    else fresh += 1;
  }
  return fresh;
}

/**
 * Whether a capture taken after paging is the page the swipe landed on,
 * without a second read to confirm it: most of what it reads is new, clock-like
 * values aside, and it is not sparser. A capture that reads the same may be
 * the screen before the scroll rendered, or the end of the list; one that
 * differs by a line or two may be that screen with a counter ticking beside
 * it; a sparser one may be a windowed list between the scroll and the rows it
 * draws for it. Only those need another look. A page whose rows differ by a
 * clock-like value alone is not vouched for here either, since a clock ticking
 * beside the stale screen reads just like it: it takes the look that proves
 * it holds still, while `pageMoved` keeps it paging.
 */
export function pageLanded(before: PageReading, after: PageReading): boolean {
  if (after.lines.length < before.lines.length || sameLines(before, after)) return false;
  return newLines(before, after) >= Math.ceil(after.lines.length * LANDED_NEW_SHARE);
}
