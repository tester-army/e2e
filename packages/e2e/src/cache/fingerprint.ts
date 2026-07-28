/**
 * Starting screen fingerprint (spec 10-determinism.md "Cache identity").
 *
 * The fingerprint answers one question: is the app in the same semantic state
 * the entry was recorded in? It hashes the semantic tree after removing node
 * refs, geometry, secure values, and volatile focus state, together with the
 * URL origin/path/query and the exact viewport. Anything the model could not
 * perceive is excluded, so a fingerprint match means the model would have seen
 * the same screen. A mismatch is a miss, never a wrong answer.
 */

import type { SemanticNode } from '../driver/index.ts';
import { canonicalDigest } from '../internal/ids.ts';
import { normalizeText } from '../internal/text.ts';

/**
 * Node states that contribute to the fingerprint. `focused` is deliberately
 * absent: focus moves for reasons unrelated to the screen's identity. `secure`
 * is absent because the secure value itself is already excluded.
 */
const FINGERPRINT_STATES = ['checked', 'disabled', 'selected', 'expanded', 'hidden'] as const;

/** Attributes that contribute, beyond the configured test-ID attribute. */
const FINGERPRINT_ATTRIBUTES = ['type', 'autocomplete', 'href', 'role'] as const;

/** Canonical projection of one node, ready for JCS. */
interface FingerprintNode {
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly inputPurpose?: string;
  readonly states?: Readonly<Record<string, boolean>>;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly FingerprintNode[];
}

export interface FingerprintInput {
  readonly tree: SemanticNode;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
  /** Current top-level URL, or undefined for a driver that exposes none. */
  readonly url: string | undefined;
  /** Replaces every exact registered secret value with its stable name. */
  readonly redact: (text: string) => string;
  readonly testIdAttribute: string;
}

/** SHA-256/JCS of the canonical screen projection. */
export function screenFingerprint(input: FingerprintInput): string {
  return canonicalDigest({
    url: input.url === undefined ? null : canonicalUrl(input.url, input.redact),
    viewport: `${input.viewport.width}x${input.viewport.height}@${input.viewport.scale}`,
    tree: fingerprintNode(input.tree, input.redact, input.testIdAttribute),
  });
}

/**
 * Reduces a URL to origin, path, and query. Userinfo and fragment are dropped:
 * neither is part of the screen's identity and userinfo can carry credentials.
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
    .toSorted((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  const query = params.map(([key, value]) => `${key}=${value}`).join('&');
  return `${url.origin}${url.pathname}${query === '' ? '' : `?${query}`}`;
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Projects one node and its subtree. Undefined and empty fields are omitted
 * rather than serialized as empty strings, so a driver that reports an absent
 * name as `''` and one that omits it produce the same digest.
 */
function fingerprintNode(
  node: SemanticNode,
  redact: (text: string) => string,
  testIdAttribute: string,
): FingerprintNode {
  const name = text(node.name, redact);
  const body = text(node.text, redact);
  const children = (node.children ?? []).map((child) =>
    fingerprintNode(child, redact, testIdAttribute),
  );
  return {
    ...(node.role === undefined || node.role === '' ? {} : { role: node.role }),
    ...(name === undefined ? {} : { name }),
    ...(body === undefined ? {} : { text: body }),
    ...secureSafeValue(node, redact),
    ...(node.inputPurpose === undefined || node.inputPurpose === 'none'
      ? {}
      : { inputPurpose: node.inputPurpose }),
    ...states(node),
    ...attributes(node, redact, testIdAttribute),
    ...(children.length === 0 ? {} : { children }),
  };
}

/**
 * A secure field's value never contributes. Its presence still does, through
 * the node's role and purpose, so a password field appearing or disappearing
 * changes the fingerprint without revealing anything about its contents.
 */
function secureSafeValue(
  node: SemanticNode,
  redact: (text: string) => string,
): { value?: string } {
  if (node.states?.secure === true) return {};
  const value = text(node.value, redact);
  return value === undefined ? {} : { value };
}

function states(node: SemanticNode): { states?: Record<string, boolean> } {
  const present: Record<string, boolean> = {};
  for (const key of FINGERPRINT_STATES) {
    const value = node.states?.[key];
    if (value !== undefined) present[key] = value;
  }
  return Object.keys(present).length === 0 ? {} : { states: present };
}

function attributes(
  node: SemanticNode,
  redact: (text: string) => string,
  testIdAttribute: string,
): { attributes?: Record<string, string> } {
  const source = node.attributes;
  if (source === undefined) return {};
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === '') continue;
    if (key === testIdAttribute || key.startsWith('aria-') || includes(key)) {
      allowed[key] = redact(value);
    }
  }
  return Object.keys(allowed).length === 0 ? {} : { attributes: allowed };
}

function includes(key: string): boolean {
  return (FINGERPRINT_ATTRIBUTES as readonly string[]).includes(key);
}

function text(value: string | undefined, redact: (input: string) => string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeText(redact(value));
  return normalized === '' ? undefined : normalized;
}
