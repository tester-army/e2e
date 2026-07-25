/** Text normalization and matching rules (spec 03-assertions.md, 08-platforms.md). */

export type TextPattern =
  | { readonly kind: 'string'; readonly value: string; readonly exact: boolean }
  | { readonly kind: 'regexp'; readonly source: string; readonly flags: string };

export type TextMatch = string | RegExp;

/**
 * Normalizes text by trimming leading/trailing whitespace and replacing every
 * nonempty run of Unicode whitespace with one ASCII space.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
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
  const normalizedActual = normalizeText(actual);
  if (pattern.kind === 'regexp') return regexpMatches(normalizedActual, pattern);
  const normalizedExpected = normalizeText(pattern.value);
  if (pattern.exact) return normalizedActual === normalizedExpected;
  return normalizedActual.toLowerCase().includes(normalizedExpected.toLowerCase());
}

/** Substring/regexp containment matching used by toContainText. */
export function containsText(actual: string, pattern: TextPattern): boolean {
  const normalizedActual = normalizeText(actual);
  if (pattern.kind === 'regexp') return regexpMatches(normalizedActual, pattern);
  const normalizedExpected = normalizeText(pattern.value);
  if (pattern.exact) return normalizedActual.includes(normalizedExpected);
  return normalizedActual.toLowerCase().includes(normalizedExpected.toLowerCase());
}

function regexpMatches(actual: string, pattern: { source: string; flags: string }): boolean {
  const regexp = new RegExp(pattern.source, pattern.flags);
  regexp.lastIndex = 0;
  return regexp.test(actual);
}

/** Renders a pattern for diagnostics. */
export function describePattern(pattern: TextPattern): string {
  if (pattern.kind === 'string') return JSON.stringify(pattern.value);
  return `/${pattern.source}/${pattern.flags}`;
}
