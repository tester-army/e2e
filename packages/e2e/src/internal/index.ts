/**
 * Shared implementation primitives for first-party backend packages,
 * published as `e2e/internal`.
 *
 * This subpath is NOT part of the stable public API and carries no semver
 * guarantee: it exists so first-party backend packages can share a
 * single copy of semantics the spec requires every backend to reproduce
 * exactly - text-pattern matching (spec 04-locators.md), URL policy and
 * matching (spec 14-security.md), the runner error taxonomy (spec 06-cli.md),
 * and assertion polling (spec 03-assertions.md). It also carries the small
 * mechanics every backend repeats, such as stripping the terminal control
 * sequences backends put in their messages, so two backends cannot disagree
 * about what a report shows.
 *
 * Third-party backends should depend only on `e2e/backend`.
 */

export { causeMessage, sanitizeFilename } from './backend-text.ts';
export { ConfigurationError, InfrastructureError, TestError } from './errors.ts';
export { validateJsonValue } from './json-value.ts';
export { packageVersion } from './package-version.ts';
export { escapeRegexpChar, testPattern } from './regexp.ts';
export { describePattern, matchesText, toTextPattern } from './text.ts';
export { Deadline, pollCondition, withTimeout } from './time.ts';
export { normalizeBaseUrl, urlMatches, type NormalizedBaseUrl } from './urls.ts';
