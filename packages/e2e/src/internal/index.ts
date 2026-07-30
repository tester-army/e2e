/**
 * Shared implementation primitives for first-party driver packages, published
 * as `e2e/internal`.
 *
 * This subpath is NOT part of the stable public API and carries no semver
 * guarantee: it exists so `@e2edev/playwright`, `@e2edev/agent-device`, and
 * their siblings can share a single copy of semantics the spec requires every
 * driver to reproduce exactly — text-pattern matching (spec 04-locators.md),
 * route-pattern matching (spec 08-web.md), and the runner error taxonomy
 * (spec 06-cli.md), where sharing one class identity is what keeps `instanceof`
 * classification working across package boundaries. It also carries the small
 * mechanics every backend repeats — waiting, timing out, and stripping the
 * terminal control sequences backends put in their messages — so two drivers
 * cannot disagree about what a report shows.
 *
 * Third-party drivers should depend only on `e2e/driver`.
 */

export { causeMessage, sanitizeFilename } from './driver-text.ts';
export { InfrastructureError } from './errors.ts';
export { packageVersion } from './package-version.ts';
export { matchesText } from './text.ts';
export { sleep, withTimeout } from './time.ts';
export { routePatternMatches, routePatternsEqual } from './route-pattern.ts';
