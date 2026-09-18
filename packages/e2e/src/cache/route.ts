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
 * So a location is reduced to its route: the pathname with every segment
 * that names a record abstracted to `:id`, the query and the fragment
 * dropped, and hash routing (`#/companies/1`) read as the path it is. What
 * names a record is decided per segment, by shape (a uuid, a hex or digit
 * run, a random token, text with spaces) or by knowledge (a value this call
 * marked with `unique()`, in any spelling a URL gives it, its slug included).
 *
 * Two routes that still differ in exactly one segment are left to the
 * screen to decide. A slug of a record the runner never saw the value of
 * (`/products/summer-sneaker` against `/products/winter-boot`) reads as two
 * literals, and only the screen can say whether they are the same page: at
 * the start of a step, the recorded signature of the screen's controls; at
 * the end, the recorded anchors. A device engine reports a screen title in
 * place of a URL, which is already a route and compares as itself.
 */

import { describeTarget } from '../agent/actions.ts';
import type { SemanticNode } from '../engine/surface.ts';
import { isVolatileAnchor } from './anchors.ts';
import type { DescriptorMatchOptions } from './relocate.ts';
import { MAX_SCREEN_SIGNATURE, MAX_SCREEN_SIGNATURE_CHARS } from './trace.ts';

/** One segment of a route: text the app's router owns, or a value it minted or was given. */
export interface RouteSegment {
  readonly kind: 'literal' | 'param';
  readonly text: string;
}

export interface Route {
  /** `/backend/customers/companies-v2/:id`; the location itself when it is not a URL. */
  readonly key: string;
  /** The classified segments of a URL route; undefined for an opaque location. */
  readonly segments: readonly RouteSegment[] | undefined;
}

const PARAM_PLACEHOLDER = ':id';

/**
 * A segment shaped like a value the app mints per record: a uuid, a hex or
 * digit run, a long random token (twelve or more url-safe characters carrying
 * two digits or both letter cases, which a route word such as
 * `companies-v2` never does), or text with whitespace in it, which no router
 * puts in a path.
 */
const MINTED_SEGMENT: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^\d+$/,
  /^(?=(?:[^\d]*\d){2}|.*(?:[a-z][A-Za-z0-9_-]*[A-Z]|[A-Z][A-Za-z0-9_-]*[a-z]))[A-Za-z0-9_-]{12,}$/,
  /\s/,
];

/** Lowercase, letters and digits only, runs of anything else as one dash: how apps slug a name. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '');
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return raw;
  }
}

/**
 * The pathname a location routes by, or undefined when the location is not
 * URL-shaped (a device engine's screen title). The query and the fragment
 * are not part of it, except that an app routing in the fragment
 * (`/#/companies/1`) routes by the fragment's path.
 */
function pathnameOf(location: string): string | undefined {
  let rest = location;
  if (URL.canParse(location)) {
    const url = new URL(location);
    rest = `${url.pathname}${url.search}${url.hash}`;
  } else if (!location.startsWith('/')) {
    return undefined;
  }
  const hashAt = rest.indexOf('#');
  const fragment = hashAt === -1 ? '' : rest.slice(hashAt + 1);
  let pathname = (hashAt === -1 ? rest : rest.slice(0, hashAt)).split('?')[0] ?? '';
  if (fragment.startsWith('/')) pathname = fragment.split('?')[0] ?? fragment;
  return pathname;
}

/**
 * The route of a location. `knownValues` are the values this call marked as
 * per-run (`unique()`): a segment spelling one of them, raw, decoded, or as
 * its slug, names a record whatever its shape.
 */
export function routeOf(location: string, knownValues: readonly string[] = []): Route {
  const pathname = pathnameOf(location);
  if (pathname === undefined) return { key: location, segments: undefined };
  const known = new Set(knownValues);
  const knownSlugs = new Set(knownValues.map(slugOf).filter((slug) => slug !== ''));
  const segments: RouteSegment[] = pathname
    .split('/')
    .filter((raw) => raw !== '')
    .map((raw) => {
      const text = decodeSegment(raw);
      const param =
        known.has(text) ||
        known.has(raw) ||
        knownSlugs.has(slugOf(text)) ||
        MINTED_SEGMENT.some((pattern) => pattern.test(text));
      return { kind: param ? 'param' : 'literal', text };
    });
  return {
    key: `/${segments.map((segment) => (segment.kind === 'param' ? PARAM_PLACEHOLDER : segment.text)).join('/')}`,
    segments,
  };
}

/**
 * Whether two routes are the same screen. Equal keys are. Routes of the same
 * depth that differ in exactly one segment may be, when the difference is a
 * record the runner could not recognize by shape, a slug, and `arbiter`,
 * which looks at the screen, says so. Anything else is another screen.
 */
export function sameRoute(recorded: Route, live: Route, arbiter: () => boolean): boolean {
  if (recorded.key === live.key) return true;
  if (recorded.segments === undefined || live.segments === undefined) return false;
  if (recorded.segments.length !== live.segments.length) return false;
  const differing = recorded.segments.filter((segment, index) => segmentKey(segment) !== segmentKey(live.segments![index]!));
  return differing.length === 1 && arbiter();
}

function segmentKey(segment: RouteSegment): string {
  return segment.kind === 'param' ? PARAM_PLACEHOLDER : segment.text;
}

/** How much of a recorded signature must be on screen again for the screens to count as the same. */
const SIGNATURE_MATCH_RATIO = 0.6;
/** Fewer entries than this cannot tell one screen from another. */
const MIN_SIGNATURE_ENTRIES = 4;

const SIGNATURE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'heading',
]);

/**
 * What a screen is made of, as the controls a user would name it by: the
 * roles and names of its buttons, links, fields, tabs, and headings, in
 * document order, without text that reads differently on another visit (a
 * date, a count, a value this call marked). Two visits to the same screen
 * share most of it; two screens rarely do.
 */
export function screenSignature(
  nodes: ReadonlyMap<string, SemanticNode>,
  options: DescriptorMatchOptions,
  knownValues: readonly string[] = [],
): readonly string[] {
  const known = new Set(knownValues);
  const entries = new Set<string>();
  for (const node of nodes.values()) {
    if (node.role === undefined || !SIGNATURE_ROLES.has(node.role)) continue;
    const described = describeTarget(node, options.redact);
    if (described === undefined) continue;
    const name = described.name ?? described.placeholder ?? described.text;
    if (name === undefined || known.has(name) || isVolatileAnchor(described)) continue;
    const entry = `${node.role}:${name}`;
    if (entry.length > MAX_SCREEN_SIGNATURE_CHARS) continue;
    entries.add(entry);
    if (entries.size >= MAX_SCREEN_SIGNATURE) break;
  }
  return [...entries];
}

/** Whether enough of a recorded signature is on the live screen for it to be the same screen. */
export function signatureMatches(recorded: readonly string[], live: readonly string[]): boolean {
  if (recorded.length < MIN_SIGNATURE_ENTRIES) return false;
  const present = new Set(live);
  const shared = recorded.filter((entry) => present.has(entry)).length;
  return shared / recorded.length >= SIGNATURE_MATCH_RATIO;
}
