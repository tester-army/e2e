/** Rendered node properties an engine's `readStyle` may be asked for. */
import { TestError } from '../internal/errors.ts';

/** CSS properties whose computed values contain presentation data rather than URLs or generated content. */
export const COMPUTED_STYLE_PROPERTIES = Object.freeze([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style',
  'text-align', 'text-decoration-line', 'display', 'visibility', 'opacity',
] as const);

export type ComputedStyleProperty = (typeof COMPUTED_STYLE_PROPERTIES)[number];

/** Computed CSS strings keyed by the properties requested from an engine. */
export type ComputedStyleValues = Readonly<Partial<Record<ComputedStyleProperty, string>>>;

/** Checks, deduplicates, and copies the requested properties before any engine or page access. */
export function validateComputedStyleProperties(properties: readonly ComputedStyleProperty[]): readonly ComputedStyleProperty[] {
  const requested: readonly unknown[] = Array.isArray(properties) ? [...new Set<unknown>(properties)] : [];
  const allowed: readonly unknown[] = COMPUTED_STYLE_PROPERTIES;
  if (requested.length === 0 || requested.some((property) => !allowed.includes(property))) {
    throw new TestError('INVALID_ARGUMENT', `style must list at least one of ${COMPUTED_STYLE_PROPERTIES.join(', ')}`);
  }
  return requested as readonly ComputedStyleProperty[];
}
