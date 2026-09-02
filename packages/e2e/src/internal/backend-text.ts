/**
 * Text helpers every backend package repeats. Backend messages and artifact
 * labels reach reports and terminals, so stripping control sequences and
 * constraining filenames happens in exactly one place rather than once per
 * backend, where two copies would eventually disagree about what a report shows.
 */

/** Backends colorize call logs; escape codes are noise in reports. */
// oxlint-disable-next-line no-control-regex -- intentionally matches the ESC control character
const ANSI_PATTERN = /\u001b\[\d+(?:;\d+)*m/g;

/** Returns a backend failure's message with terminal control sequences removed. */
export function causeMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(ANSI_PATTERN, '');
}

/** Constrains a caller-supplied artifact label to a safe filename. */
export function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}
