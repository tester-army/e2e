/**
 * Portable query derivation and node-signature comparison.
 *
 * Everything here is pure: it turns one observed node into the candidate
 * `screen` queries that might re-find it, and decides whether a node resolved
 * later is the same node. No driver, no invocation, no I/O — which is what makes
 * the locate loop that consumes it testable a level up.
 *
 * A derived candidate never contains a node reference, a coordinate, or a
 * selector, and never an index: a query addresses a node by what it says, never
 * by where it sits. That is the reason a locator's shape cannot tell anyone
 * whether the instruction behind it was positional (see `LocateResponse`).
 */

import {
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  type LocatorExpression,
  type SemanticNode,
} from '../driver/index.ts';
import {
  filterExpression,
  frameExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from '../locator/expression.ts';
import type { Role } from '../types.ts';

/**
 * Scopes one derived query to the observed node's enclosing frame chain, so a
 * node inside an iframe re-resolves through the same frames deterministically.
 */
export function scopeToFrames(
  query: LocatorExpression,
  framePath: readonly string[] | undefined,
): LocatorExpression {
  if (framePath === undefined || framePath.length === 0) return query;
  return framePath.reduceRight((source, selector) => frameExpression(selector, source), query);
}

/**
 * Bounded prefix used to re-find nodes whose names aggregate a whole card of
 * text. Long names diverge between accessible-name computation and rendered
 * text (image alts, badges), so a role-scoped text-content prefix filter is
 * the reliable signal; the identity signature still checks the full name.
 */
const NAME_PREFIX_LENGTH = 64;

/**
 * True when an observed field was cut at the driver contract's observation
 * bound (`OBSERVED_NAME_LIMIT` / `OBSERVED_TEXT_LIMIT`). Checked on the raw
 * value — normalization only shrinks — so every value below the limit is
 * provably complete. Truncated values are matched as substrings and compared
 * as prefixes.
 */
function truncatedAt(value: string | undefined, limit: number): boolean {
  return (value ?? '').length >= limit;
}

/**
 * Matches an observed-text prefix regardless of whitespace differences. The
 * observed name comes from rendered text, which inserts spaces at element
 * boundaries that raw text content does not have (and vice versa), so every
 * space matches any amount of whitespace including none. Case-insensitive
 * because rendering may also apply text transforms.
 */
function prefixPattern(value: string): RegExp {
  const escaped = value
    .slice(0, NAME_PREFIX_LENGTH)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s*');
  return new RegExp(escaped, 'i');
}

/**
 * Derives candidate `screen` queries for one observed node, most portable
 * first. A candidate never contains a node reference, coordinate, or selector.
 */
export function deriveQueries(
  node: SemanticNode,
  testIdAttribute: string,
): readonly LocatorExpression[] {
  const candidates: LocatorExpression[] = [];
  const role = node.role;
  const name = normalizeSignatureText(node.name);
  const text = normalizeSignatureText(node.text);
  const nameTruncated = truncatedAt(node.name, OBSERVED_NAME_LIMIT);
  const textTruncated = truncatedAt(node.text, OBSERVED_TEXT_LIMIT);
  // A name this long is an aggregate of a whole card rather than a label, so it
  // cannot be matched exactly even when it arrived complete: the driver
  // recomputes the accessible name at resolve time and a single space, or a
  // nested control's text, is enough to make an exact match find nothing. A
  // truncated name has the same problem for a different reason, so both take the
  // whitespace-tolerant prefix filter.
  const nameUnmatchable = nameTruncated || name.length > NAME_PREFIX_LENGTH;
  const testId = node.attributes?.[testIdAttribute];
  const placeholder = node.attributes?.['placeholder'];

  if (role !== undefined && role !== '' && name !== '') {
    candidates.push(roleQuery(role as Role, { name, exact: !nameTruncated }, undefined));
    if (nameUnmatchable) {
      candidates.push(
        filterExpression(roleQuery(role as Role, undefined, undefined), {
          hasText: prefixPattern(name),
        }),
      );
    }
  }
  if (testId !== undefined && testId !== '') {
    const byTestId = testIdQuery(testId, undefined);
    const disambiguator = name !== '' ? name : text;
    if (disambiguator !== '') {
      candidates.push(filterExpression(byTestId, { hasText: disambiguator }));
    }
    candidates.push(byTestId);
  }
  if (placeholder !== undefined && placeholder !== '') {
    candidates.push(textQuery('placeholder', placeholder, { exact: true }, undefined));
  }
  if (name !== '') {
    candidates.push(textQuery('label', name, { exact: !nameTruncated }, undefined));
    candidates.push(textQuery('text', name, { exact: !nameTruncated }, undefined));
  }
  if (text !== '' && text !== name) {
    candidates.push(textQuery('text', text, { exact: !textTruncated }, undefined));
  }
  if (role !== undefined && role !== '' && text !== '') {
    candidates.push(
      filterExpression(roleQuery(role as Role, undefined, undefined), { hasText: text }),
    );
  }
  return candidates;
}

/**
 * Compares the observed node with the node a derived query resolved to. Both
 * sides are produced by the same driver reader, so role, purpose, and name are
 * directly comparable.
 */
export function matchesSignature(observed: SemanticNode, resolved: SemanticNode): boolean {
  if (
    observed.role !== undefined &&
    observed.role !== 'document' &&
    resolved.role !== observed.role
  ) {
    return false;
  }
  if (
    observed.inputPurpose !== undefined &&
    resolved.inputPurpose !== undefined &&
    observed.inputPurpose !== resolved.inputPurpose
  ) {
    return false;
  }
  const observedName = normalizeSignatureText(observed.name);
  if (observedName !== '') {
    const resolvedName = normalizeSignatureText(resolved.name);
    // A truncated observed name identifies its node by prefix; the re-read
    // node comes from an unbounded single-node read and carries the full name.
    return truncatedAt(observed.name, OBSERVED_NAME_LIMIT)
      ? resolvedName.startsWith(observedName)
      : resolvedName === observedName;
  }
  const observedText = normalizeSignatureText(observed.text);
  if (observedText === '') return true;
  return normalizeSignatureText(resolved.text).includes(observedText);
}

/** Role and name of one node, for locate diagnostics. */
export function describeSignature(node: SemanticNode): string {
  return `role=${node.role ?? 'none'} name=${JSON.stringify(normalizeSignatureText(node.name))}`;
}

/** Collapses whitespace so two renderings of the same text compare equal. */
export function normalizeSignatureText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
