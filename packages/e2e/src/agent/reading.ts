/**
 * Reading a screen for a text the agent pages toward: which node reads it,
 * and what the screen reads as a whole, for telling a page that moved from
 * one that did not. A module of its own so the rules are tested as rules.
 */

import type { SemanticNode } from '../engine/surface.ts';

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
  observation: { readonly nodes: ReadonlyMap<string, SemanticNode> },
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

/**
 * What a screen reads and where, for telling a page that moved from one that
 * did not. Name and text both count: a windowed list's rows keep one name
 * and one slot on the screen while the text in them changes, and that is the
 * list moving.
 */
export function readingShape(observation: { readonly nodes: ReadonlyMap<string, SemanticNode> }): string {
  const lines: string[] = [];
  for (const node of observation.nodes.values()) {
    if (node.name === undefined && node.text === undefined) continue;
    const at = node.rect === undefined ? '' : `${String(Math.round(node.rect.x))},${String(Math.round(node.rect.y))}`;
    lines.push(`${node.name ?? ''}|${node.text ?? ''}@${at}`);
  }
  return lines.join('\n');
}
