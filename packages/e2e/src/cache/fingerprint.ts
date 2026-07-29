/**
 * Starting route fingerprint (spec 10-determinism.md "Cache identity").
 *
 * The fingerprint answers one question: is this the same place in the app? It
 * hashes the canonical URL and the exact viewport, and nothing else.
 *
 * It deliberately does not hash the semantic tree. Doing so made the key
 * change whenever any rendered content changed — a price, a review count, an
 * ad slot — so on a real application every entry was invalidated within hours
 * and the cache never returned a hit. The tree is also the wrong thing to
 * guard with: what makes replay safe is that the recorded locator expresses
 * the same intent as the instruction, so a positional target replays by
 * position and a content target replays by content. Correctness comes from the
 * locator's shape, verified against the live node before the action runs, not
 * from proving the screen never changed.
 *
 * Two calls that share a route are still separated by their instruction, their
 * parameters, and their occurrence index, so a single-page flow that never
 * changes URL keys each step independently.
 */

import { canonicalDigest, compareStrings } from '../internal/ids.ts';

export interface FingerprintInput {
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
  /** Current top-level URL, or undefined for a driver that exposes none. */
  readonly url: string | undefined;
  /** Replaces every exact registered secret value with its stable name. */
  readonly redact: (text: string) => string;
}

/** SHA-256/JCS of the canonical route projection. */
export function screenFingerprint(input: FingerprintInput): string {
  return canonicalDigest({
    url: input.url === undefined ? null : canonicalUrl(input.url, input.redact),
    viewport: `${input.viewport.width}x${input.viewport.height}@${input.viewport.scale}`,
  });
}

/**
 * Reduces a URL to origin, path, and query. Userinfo and fragment are dropped:
 * neither is part of the route's identity and userinfo can carry credentials.
 * Query parameters are sorted so that a reordered but equivalent query stays a
 * hit, and every exact registered secret becomes its stable name.
 */
function canonicalUrl(href: string, redact: (text: string) => string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const params = [...url.searchParams]
    .map(([key, value]) => [redact(key), redact(value)] as const)
    .toSorted((a, b) => (a[0] === b[0] ? compareStrings(a[1], b[1]) : compareStrings(a[0], b[0])));
  const query = params.map(([key, value]) => `${key}=${value}`).join('&');
  return `${url.origin}${url.pathname}${query === '' ? '' : `?${query}`}`;
}
