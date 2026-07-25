/** Shared regular-expression plumbing for the glob, route, text, and URL matchers. */

/** Escapes one character for literal use inside a regexp source. */
export function escapeRegexpChar(ch: string): string {
  return /[a-zA-Z0-9_\-]/.test(ch) ? ch : `\\${ch}`;
}

/**
 * Tests input against a wire regexp (source + flags). A fresh RegExp is
 * constructed per call, so sticky/global state can never leak between matches.
 */
export function testPattern(source: string, flags: string, input: string): boolean {
  return new RegExp(source, flags).test(input);
}
