/**
 * Starting route fingerprint (spec 10-determinism.md "Cache identity").
 *
 * The fingerprint answers one question: is this the same place in the app? It
 * hashes the canonical route and the exact viewport, and nothing else.
 *
 * "The same place" is deliberately independent of which deployment served it. A
 * route inside the app is stored relative to the configured base, so a Vercel
 * preview, a staging host, and `localhost` on yesterday's port are one place,
 * not three. An off-origin page keeps its origin, because an identity provider's
 * `/login` is not the app's `/login`.
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
 * changes URL keys each step independently — which is also why collapsing the
 * record identifiers out of a path cannot merge two calls that differ.
 */

import { canonicalDigest, compareStrings } from '../internal/ids.ts';

export interface FingerprintInput {
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
  /** Current top-level URL, or undefined for a driver that exposes none. */
  readonly url: string | undefined;
  /** Configured app base, which routes inside the app are expressed against. */
  readonly base: { readonly origin: string; readonly basePath: string };
  /** Replaces every exact registered secret value with its stable name. */
  readonly redact: (text: string) => string;
}

/** SHA-256/JCS of the canonical route projection. */
export function screenFingerprint(input: FingerprintInput): string {
  return canonicalDigest({
    url: input.url === undefined ? null : canonicalRoute(input.url, input.base, input.redact),
    viewport: `${input.viewport.width}x${input.viewport.height}@${input.viewport.scale}`,
  });
}

/**
 * Reduces a URL to a normalized route and query. Userinfo and fragment are
 * dropped: neither is part of the route's identity and userinfo can carry
 * credentials. Query parameters are sorted so that a reordered but equivalent
 * query stays a hit, and every exact registered secret becomes its stable name.
 */
function canonicalRoute(
  href: string,
  base: FingerprintInput['base'],
  redact: (text: string) => string,
): string | null {
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
  const inApp = url.origin === base.origin;
  const path = normalizePath(inApp ? relativeToBase(url.pathname, base.basePath) : url.pathname);
  return `${inApp ? '' : url.origin}${path}${query === '' ? '' : `?${query}`}`;
}

/**
 * Expresses one in-app path against the configured base path, so an app mounted
 * at `/shop` in one deployment and at the root in another describes its routes
 * the same way.
 */
function relativeToBase(pathname: string, basePath: string): string {
  const base = basePath.replace(/\/+$/, '');
  if (base === '' || !pathname.startsWith(base)) return pathname;
  const rest = pathname.slice(base.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Opaque record identifier: a UUID, a long hex digest, or an id-like token. */
const RECORD_ID = /^(?:\d+|[0-9a-f]{12,}|(?=[^/]*\d)[A-Za-z0-9._~-]{16,})$/i;

/**
 * Replaces every path segment that identifies a record rather than a place.
 *
 * A checkout that lives at `/rezerwacja/<order hash>/form` is the same place on
 * every run, but the hash is minted per session, so hashing the raw path gives
 * every visit its own key: nothing ever hits, and the store grows one dead entry
 * per run. The fingerprint answers "is this the same place in the app?", and an
 * opaque identifier answers "which record?", so it is not part of the answer.
 *
 * Two places that differ only by such a segment do collapse — `/offers/1` and
 * `/offers/2` — and that is safe because a key is never a route alone: the
 * instruction, the parameters, and the occurrence index still separate the
 * calls, and every replay re-resolves and re-checks the node before acting.
 */
function normalizePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (RECORD_ID.test(segment) ? ':id' : segment))
    .join('/');
}
