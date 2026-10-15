/**
 * The CSS media features the engine emulates: one set of values from
 * `web({ colorScheme, reducedMotion })` for every attempt, and the same names
 * on `browser.emulateMedia()` for the rest of one.
 */

/** User preferences a page reads through `@media` rules and `matchMedia`, as Playwright's `emulateMedia` sets them. */
export interface WebMedia {
  /** `prefers-color-scheme`: `'light'`, `'dark'`, or `'no-preference'`. */
  readonly colorScheme?: 'light' | 'dark' | 'no-preference';
  /** `prefers-reduced-motion`: `'reduce'` or `'no-preference'`. */
  readonly reducedMotion?: 'reduce' | 'no-preference';
}

/** Every emulated feature and the values it takes, kept equal to `WebMedia` by the compiler. */
const MEDIA_VALUES = {
  colorScheme: ['light', 'dark', 'no-preference'],
  reducedMotion: ['reduce', 'no-preference'],
} as const satisfies { readonly [Key in keyof WebMedia]-?: readonly NonNullable<WebMedia[Key]>[] };

/** The feature names `WebMedia` takes, for unknown-key checks. */
export const MEDIA_KEYS = Object.keys(MEDIA_VALUES) as readonly (keyof WebMedia)[];

/**
 * Why one feature's value is refused, naming it the way `where` does; undefined
 * for a value the browser emulates, and for an unset one. Config and tests run
 * as JavaScript, so the types alone are no guard.
 */
export function mediaProblem(where: (key: keyof WebMedia) => string, key: keyof WebMedia, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const allowed: readonly string[] = MEDIA_VALUES[key];
  if (typeof value === 'string' && allowed.includes(value)) return undefined;
  const names = allowed.map((name) => JSON.stringify(name));
  return `${where(key)} must be ${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} or ${names.at(-1)}, got ${describe(value)}`;
}

/** The step label of a `browser.emulateMedia` call: the features it sets, read defensively since the label runs before validation. */
export function mediaLabel(media: unknown): string {
  if (typeof media !== 'object' || media === null) return '';
  return MEDIA_KEYS.flatMap((key) => {
    const value: unknown = Reflect.get(media, key);
    return typeof value === 'string' && mediaProblem(String, key, value) === undefined ? [`${key}: ${value}`] : [];
  }).join(', ');
}

/** A refused value as a message shows it: a string quoted, another primitive as written, anything else by its kind, never serialized. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : typeof value;
}
