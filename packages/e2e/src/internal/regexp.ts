/** Shared regular-expression plumbing for the glob, text, and URL matchers. */

/** Escapes one character for literal use inside a regexp source. */
export function escapeRegexpChar(ch: string): string {
  return /[a-zA-Z0-9_-]/.test(ch) ? ch : `\\${ch}`;
}

/** Compiled wire patterns, bounded; assertion polls test the same pattern many times a second. */
const MAX_CACHED_PATTERNS = 256;
const compiled = new Map<string, RegExp>();

/**
 * Tests input against a wire regexp (source + flags). Compiled patterns are
 * cached by source and flags; `lastIndex` is reset before every test, so
 * sticky/global state can never leak between matches.
 */
export function testPattern(source: string, flags: string, input: string): boolean {
  const key = `${flags}\n${source}`;
  let pattern = compiled.get(key);
  if (pattern === undefined) {
    pattern = new RegExp(source, flags);
    if (compiled.size >= MAX_CACHED_PATTERNS) {
      compiled.delete(compiled.keys().next().value as string);
    }
    compiled.set(key, pattern);
  }
  pattern.lastIndex = 0;
  return pattern.test(input);
}
