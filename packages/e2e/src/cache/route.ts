/**
 * Where a screen is, as a route rather than a URL.
 *
 * The replay precondition asks "is the app on the screen this recording
 * began on", and the postcondition "did we land where the recording landed".
 * A URL answers neither directly: it carries the id the app minted for this
 * run's record, the slug of the record the test happened to open, a search
 * term in the query, a tracking parameter, a fragment. All of that changes
 * between two visits to the same screen, and none of it is the screen.
 *
 * So a location is reduced to its route: the pathname's segments, with every
 * segment that looks minted per record (a uuid, a hex or digit run, a long
 * token mixing letters and digits, text with whitespace) replaced by `:id`;
 * the query and the fragment dropped, except that an app routing in the
 * fragment (`#/companies/1`) routes by that path. A value the call marked
 * with `unique()` needs no rule here: the recording spells it as a
 * placeholder in every spelling a URL gives it, its slug included
 * (`cache/template.ts`), and replay fills in this run's value on both sides.
 *
 * Two routes that still differ in exactly one segment are `undecided`: a slug
 * of a record the runner never saw the value of reads as two literals, and
 * only the screen can say whether they are the same page. The caller asks
 * the screen, with the recorded start anchors at the start of a step and the
 * recorded end anchors at its end. A device engine reports a screen title in
 * place of a URL, which is already a route and compares as itself.
 */

export type Route =
  | { readonly kind: 'url'; readonly segments: readonly string[] }
  | { readonly kind: 'opaque'; readonly location: string };

export type RouteVerdict = 'same' | 'different' | 'undecided';

const PARAM = ':id';

/**
 * A segment shaped like a value the app mints per record: a uuid, a hex or
 * digit run, a long token carrying letters and at least two digits (a route
 * word such as `companies-v2` has one), or text with whitespace, which no
 * router puts in a path. A capitalized or dashed word is none of these; two
 * of them differing is left to the screen.
 */
const MINTED_SEGMENT: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^\d+$/,
  /^(?=(?:[^\d]*\d){2})(?=.*[A-Za-z])[A-Za-z0-9_-]{12,}$/,
  /\s/,
];

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The pathname a location routes by, or undefined when the location is not
 * a web address (a device engine's screen title, a browser's own page).
 */
function pathnameOf(location: string): string | undefined {
  let rest = location;
  if (URL.canParse(location)) {
    const url = new URL(location);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    rest = `${url.pathname}${url.search}${url.hash}`;
  } else if (!location.startsWith('/')) {
    return undefined;
  }
  const hashAt = rest.indexOf('#');
  const fragment = hashAt === -1 ? '' : rest.slice(hashAt + 1);
  const pathname = fragment.startsWith('/') ? fragment : hashAt === -1 ? rest : rest.slice(0, hashAt);
  return pathname.split('?')[0] ?? '';
}

/** The route of a location. */
export function routeOf(location: string): Route {
  const pathname = pathnameOf(location);
  if (pathname === undefined) return { kind: 'opaque', location };
  const segments = pathname
    .split('/')
    .filter((raw) => raw !== '')
    .map((raw) => {
      const text = decodeSegment(raw);
      return MINTED_SEGMENT.some((pattern) => pattern.test(text)) ? PARAM : text;
    });
  return { kind: 'url', segments };
}

/** A route as one line, for tests and diagnostics: `/companies/:id`, or the opaque location. */
export function routeKey(route: Route): string {
  return route.kind === 'url' ? `/${route.segments.join('/')}` : route.location;
}

/**
 * Whether two routes are the same screen: `same` when they read alike,
 * `undecided` when routes of one depth differ in exactly one segment, which
 * the screen must settle, and `different` otherwise.
 */
export function compareRoutes(recorded: Route, live: Route): RouteVerdict {
  if (recorded.kind === 'opaque' || live.kind === 'opaque') {
    return recorded.kind === 'opaque' && live.kind === 'opaque' && recorded.location === live.location ? 'same' : 'different';
  }
  if (recorded.segments.length !== live.segments.length) return 'different';
  let differing = 0;
  for (const [index, segment] of recorded.segments.entries()) {
    if (segment !== live.segments[index]) differing += 1;
  }
  return differing === 0 ? 'same' : differing === 1 ? 'undecided' : 'different';
}
