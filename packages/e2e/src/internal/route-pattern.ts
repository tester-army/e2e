/** Route URL pattern grammar per 08-platforms.md. */

import type { TextPattern } from './text.js';

/**
 * Compiles a string route pattern: `*` matches within one path segment, `**`
 * crosses `/`, `?` matches one character, `\` escapes the next character;
 * everything else is literal. Matches against the complete URL.
 */
export function compileRoutePattern(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 1;
      const next = pattern[i];
      if (next !== undefined) source += escapeLiteral(next);
      continue;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        source += '.*';
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '.';
      continue;
    }
    source += escapeLiteral(ch);
  }
  return new RegExp(`${source}$`);
}

function escapeLiteral(ch: string): string {
  return /[a-zA-Z0-9_\-]/.test(ch) ? ch : `\\${ch}`;
}

/** Matches a URL against a wire TextPattern (string grammar or ECMAScript regexp). */
export function routePatternMatches(pattern: TextPattern, url: string): boolean {
  if (pattern.kind === 'string') {
    return compileRoutePattern(pattern.value).test(url);
  }
  const regexp = new RegExp(pattern.source, pattern.flags);
  regexp.lastIndex = 0;
  return regexp.test(url);
}

/** Converts a public string/RegExp pattern into the wire TextPattern form. */
export function toRoutePattern(pattern: string | RegExp): TextPattern {
  if (typeof pattern === 'string') return { kind: 'string', value: pattern, exact: true };
  return { kind: 'regexp', source: pattern.source, flags: pattern.flags };
}

/** Structural equality for route patterns, used by unroute. */
export function routePatternsEqual(a: TextPattern, b: TextPattern): boolean {
  if (a.kind === 'string' && b.kind === 'string') return a.value === b.value;
  if (a.kind === 'regexp' && b.kind === 'regexp') return a.source === b.source && a.flags === b.flags;
  return false;
}
