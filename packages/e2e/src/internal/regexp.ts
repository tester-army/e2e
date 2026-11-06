/** Shared regular-expression plumbing for the glob and redaction matchers. */

/** Escapes one character for literal use inside a regexp source. */
export function escapeRegexpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
