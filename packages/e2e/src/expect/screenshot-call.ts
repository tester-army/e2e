/** The arguments of one `toHaveScreenshot` call, checked and named before anything is read. */

import { createHash } from 'node:crypto';
import type { LocatorExpression } from '../engine/surface.ts';
import { TestError } from '../internal/errors.ts';
import type { ImageTolerance } from '../internal/image.ts';
import { isPlainObject, rejectUnknownOptions } from '../internal/options.ts';
import { locatorInternals } from '../locator/screen.ts';
import type { ScreenshotContext } from '../run/screenshots.ts';
import type { ScreenshotOptions } from '../types.ts';

/** One checked call. */
export interface ScreenshotCall {
  /** The stored screenshot's name without its suffix and extension. */
  readonly stem: string;
  readonly tolerance: ImageTolerance;
  readonly masks: readonly LocatorExpression[];
  readonly maskColor: readonly [number, number, number];
  readonly timeout: number | undefined;
}

const OPTION_KEYS = ['threshold', 'maxDiffPixels', 'maxDiffPixelRatio', 'mask', 'maskColor', 'timeout'] as const;
const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_MASK_COLOR: readonly [number, number, number] = [255, 0, 255];
/** Characters a stored screenshot's name may not hold: path separators, controls, and what Windows refuses in a file name. */
const UNSAFE_NAME = /[\\/<>:"|?*\p{Cc}]/u;
/**
 * UTF-8 bytes a name may take. A file name holds 255 bytes on every common
 * file system; the target and system suffix, an attachment's `-expected`,
 * and an atomic write's temporary suffix take the rest.
 */
const MAX_NAME_BYTES = 150;
/** UTF-8 bytes of a test title an unnamed screenshot keeps; a longer title is cut and a hash of the whole added. */
const MAX_TITLE_NAME_BYTES = 100;

/** Unnamed calls per attempt, keyed by the attempt's screenshot context, so names count from 1 in each attempt. */
const unnamedCalls = new WeakMap<ScreenshotContext, number>();

/** Checks a call's arguments and names its screenshot; `INVALID_ARGUMENT` before the screen is read. */
export function parseScreenshotCall(
  api: string,
  store: ScreenshotContext,
  nameOrOptions: string | ScreenshotOptions | undefined,
  maybeOptions: ScreenshotOptions | undefined,
): ScreenshotCall {
  const named = typeof nameOrOptions === 'string';
  if (!named && nameOrOptions !== undefined && !isPlainObject(nameOrOptions)) {
    throw new TestError('INVALID_ARGUMENT', `${api} takes a name, options, or both`);
  }
  const options: ScreenshotOptions | undefined = named ? maybeOptions : (nameOrOptions ?? maybeOptions);
  rejectUnknownOptions(api, options, OPTION_KEYS);
  const maxDiffPixels: unknown = options?.maxDiffPixels;
  if (maxDiffPixels !== undefined && !(typeof maxDiffPixels === 'number' && Number.isInteger(maxDiffPixels) && maxDiffPixels >= 0)) {
    throw new TestError('INVALID_ARGUMENT', `${api} option maxDiffPixels must be a whole number of pixels, 0 or more`);
  }
  const timeout: unknown = options?.timeout;
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)) {
    throw new TestError('INVALID_ARGUMENT', `${api} option timeout must be a positive number of milliseconds`);
  }
  return {
    stem: named ? namedStem(api, nameOrOptions) : unnamedStem(store),
    tolerance: {
      threshold: fraction(api, 'threshold', options?.threshold) ?? DEFAULT_THRESHOLD,
      maxDiffPixels,
      maxDiffPixelRatio: fraction(api, 'maxDiffPixelRatio', options?.maxDiffPixelRatio),
    },
    masks: maskExpressions(api, options?.mask),
    maskColor: options?.maskColor === undefined ? DEFAULT_MASK_COLOR : parseColor(api, options.maskColor),
    timeout,
  };
}

/** A number option from 0 to 1. */
function fraction(api: string, option: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && value >= 0 && value <= 1) return value;
  throw new TestError('INVALID_ARGUMENT', `${api} option ${option} must be a number from 0 to 1`);
}

/** The stem of a name the test gave: `.png` dropped, anything that could leave the directory refused. */
function namedStem(api: string, name: string): string {
  const stem = name.toLowerCase().endsWith('.png') ? name.slice(0, -'.png'.length) : name;
  if (stem.trim() === '' || stem === '.' || stem === '..' || UNSAFE_NAME.test(stem)) {
    throw new TestError('INVALID_ARGUMENT', `${api} name must be a file name with no path separators, got ${JSON.stringify(name)}`);
  }
  if (Buffer.byteLength(stem) > MAX_NAME_BYTES) {
    throw new TestError('INVALID_ARGUMENT', `${api} name must take at most ${MAX_NAME_BYTES} bytes, got ${Buffer.byteLength(stem)}`);
  }
  return stem;
}

/**
 * A name for an unnamed call: the test's title path, lowercase so titles that
 * differ only in case never share a file on a case-insensitive disk, and a
 * count, `checkout-pays-by-card-1`. A title cut to fit keeps a hash of the whole.
 */
function unnamedStem(store: ScreenshotContext): string {
  const count = (unnamedCalls.get(store) ?? 0) + 1;
  unnamedCalls.set(store, count);
  const whole = store.titlePath.join(' ');
  // Every run of other characters is one dash, so at most one sits at each end.
  const dashed = whole.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');
  const title = dashed.slice(dashed.startsWith('-') ? 1 : 0, dashed.length > 1 && dashed.endsWith('-') ? -1 : undefined);
  const cut = cutToBytes(title, MAX_TITLE_NAME_BYTES);
  const fitted = cut === title ? title : `${cut}-${createHash('sha256').update(whole).digest('hex').slice(0, 8)}`;
  return `${fitted === '' ? 'screenshot' : fitted}-${count}`;
}

/** The longest start of `text` that takes at most `maxBytes` UTF-8 bytes, cut between code points. */
function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > maxBytes) break;
    end += point.length;
  }
  return text.slice(0, end);
}

/** The `mask` option's locators as expressions. */
function maskExpressions(api: string, mask: unknown): readonly LocatorExpression[] {
  if (mask === undefined) return [];
  if (!Array.isArray(mask)) throw new TestError('INVALID_ARGUMENT', `${api} option mask must be an array of locators`);
  return mask.map((entry: unknown) => {
    const internals = locatorInternals(entry);
    if (internals === undefined) throw new TestError('INVALID_ARGUMENT', `${api} option mask must be an array of locators`);
    return internals.expression;
  });
}

/** `#rrggbb` as its three channels. */
function parseColor(api: string, color: unknown): readonly [number, number, number] {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new TestError('INVALID_ARGUMENT', `${api} option maskColor must be a color written #rrggbb`);
  }
  return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)];
}
