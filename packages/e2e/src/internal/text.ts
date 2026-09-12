/** Text normalization and matching rules. */

import type { TextPattern } from '../engine/contract.ts';
import type { TextMatch } from '../types.ts';
import { sanitizeText } from './errors.ts';
import { testPattern } from './regexp.ts';

export type { TextPattern };

/**
 * Normalizes text by trimming leading/trailing whitespace and replacing every
 * nonempty run of Unicode whitespace with one ASCII space.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Normalizes text that may carry control characters: sanitized first, then
 * whitespace-collapsed. The one-line form of screen text that reaches models,
 * trace descriptors, and terminals.
 */
export function collapseText(text: string): string {
  return normalizeText(sanitizeText(text));
}

/** Converts a public TextMatch plus options into the wire TextPattern form. */
export function toTextPattern(match: TextMatch, options?: { exact?: boolean }): TextPattern {
  if (typeof match === 'string') {
    return { kind: 'string', value: match, exact: options?.exact ?? true };
  }
  return { kind: 'regexp', source: match.source, flags: normalizeRegexpFlags(match.flags) };
}

/** Sorts and de-duplicates regexp flags into canonical d,g,i,m,s,u,v,y order. */
export function normalizeRegexpFlags(flags: string): string {
  const order = ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];
  const present = new Set(flags.split(''));
  return order.filter((flag) => present.has(flag)).join('');
}

/**
 * Matches normalized text against a pattern. String matching is exact by
 * default; `exact: false` is case-insensitive substring matching. Regular
 * expressions use ECMAScript semantics with lastIndex reset before every match.
 */
export function matchesText(actual: string, pattern: TextPattern): boolean {
  return matchText(actual, pattern, 'equals');
}

/** Substring/regexp containment matching used by toContainText. */
export function containsText(actual: string, pattern: TextPattern): boolean {
  return matchText(actual, pattern, 'contains');
}

/**
 * The one text-matching rule. `mode` applies only to exact string patterns:
 * regexps and case-insensitive substrings read the same way in both matchers.
 */
function matchText(actual: string, pattern: TextPattern, mode: 'equals' | 'contains'): boolean {
  const normalizedActual = normalizeText(actual);
  if (pattern.kind === 'regexp') return testPattern(pattern.source, pattern.flags, normalizedActual);
  const normalizedExpected = normalizeText(pattern.value);
  if (!pattern.exact) {
    return normalizedActual.toLowerCase().includes(normalizedExpected.toLowerCase());
  }
  return mode === 'equals'
    ? normalizedActual === normalizedExpected
    : normalizedActual.includes(normalizedExpected);
}

/** Renders a pattern for diagnostics. */
export function describePattern(pattern: TextPattern): string {
  if (pattern.kind === 'string') return JSON.stringify(pattern.value);
  return `/${pattern.source}/${pattern.flags}`;
}
