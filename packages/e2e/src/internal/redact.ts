/** Runner-side secret redaction (spec 14-security.md). */

/**
 * Builds a redactor replacing every exact registered secret value with its
 * stable secret name.
 *
 * Longer values are substituted first, so a secret that contains another
 * secret is not left half-rewritten. One redactor is built per observation and
 * shared by everything derived from it — model text, traces, and cache digests
 * — because two independently built redactors could disagree about what counts
 * as a secret, and only one of them would be wrong.
 */
export function createRedactor(secrets: ReadonlyMap<string, string>): (text: string) => string {
  const entries = [...secrets]
    .filter(([, value]) => value.length > 0)
    .toSorted((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of entries) out = out.split(value).join(`<secret:${name}>`);
    return out;
  };
}
