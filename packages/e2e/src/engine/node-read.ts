/** Rendered node properties a read-only project tool may inspect. */
import { TestError } from '../internal/errors.ts';
import { rejectUnknownOptions } from '../internal/options.ts';

/** CSS properties whose computed values contain presentation data rather than URLs or generated content. */
export const COMPUTED_STYLE_PROPERTIES = Object.freeze([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style',
  'text-align', 'text-decoration-line', 'display', 'visibility', 'opacity',
] as const);

export type ComputedStyleProperty = (typeof COMPUTED_STYLE_PROPERTIES)[number];

export interface NodeReadOptions {
  /** A non-empty list of allow-listed CSS property names, in kebab case. */
  readonly style: readonly ComputedStyleProperty[];
}

/** Computed CSS strings keyed by the properties requested from an engine. */
export type ComputedStyleValues = Readonly<Partial<Record<ComputedStyleProperty, string>>>;

export interface NodeReadResult {
  /** Only the requested properties, as computed strings. The harness redacts values before returning them to tools. */
  readonly style: ComputedStyleValues;
}

/** Checks and copies the requested properties before any engine or page access. */
export function validateNodeReadOptions(options: NodeReadOptions): NodeReadOptions {
  rejectUnknownOptions('read', options, ['style']);
  if (!Array.isArray(options?.style) || options.style.length === 0 || options.style.length > COMPUTED_STYLE_PROPERTIES.length) {
    throw new TestError('INVALID_ARGUMENT', `read style must contain 1 to ${String(COMPUTED_STYLE_PROPERTIES.length)} properties`);
  }
  const properties: readonly unknown[] = options.style;
  for (const property of properties) {
    if (!COMPUTED_STYLE_PROPERTIES.includes(property as ComputedStyleProperty)) {
      throw new TestError('INVALID_ARGUMENT', `read style takes only ${COMPUTED_STYLE_PROPERTIES.join(', ')}`);
    }
  }
  return { style: [...new Set(options.style)] };
}
