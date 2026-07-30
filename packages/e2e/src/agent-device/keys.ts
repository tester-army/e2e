/**
 * Web UI Events key values to the text a mobile keyboard accepts.
 *
 * The backend has no key-press command: it types text. A key whose value is not
 * a single character therefore has to be expressed as a control character the
 * platform keyboard interprets, and a key with no such encoding must fail
 * loudly. Typing the key's name would silently insert the word "Enter" into the
 * field, which is worse than an unsupported error.
 */

import type { MobilePlatform } from './roles.ts';

/** Control characters both platforms' keyboards interpret. */
const SHARED_KEYS: Readonly<Record<string, string>> = {
  Backspace: '\u0008',
  Delete: '\u0008',
  Tab: '\t',
  Enter: '\r',
  Return: '\r',
};

/**
 * iOS-only encodings. XCUITest maps the AppKit function-key range onto the
 * arrows and escape; Android's text injection has no equivalent.
 */
const IOS_KEYS: Readonly<Record<string, string>> = {
  Escape: '\u001b',
  ArrowUp: '\uf700',
  ArrowDown: '\uf701',
  ArrowLeft: '\uf702',
  ArrowRight: '\uf703',
};

/**
 * Returns the text that presses one key, or undefined when the platform cannot
 * express it. A single-character key value is its own text, which covers every
 * printable key without a table.
 */
export function keyToText(key: string, platform: MobilePlatform): string | undefined {
  const shared = SHARED_KEYS[key];
  if (shared !== undefined) return shared;
  if (platform === 'ios') {
    const ios = IOS_KEYS[key];
    if (ios !== undefined) return ios;
  }
  // A printable key is literally itself. Code points above the BMP still count
  // as one key, so this measures characters rather than UTF-16 units.
  return [...key].length === 1 ? key : undefined;
}
