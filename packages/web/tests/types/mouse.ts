/** Coordinate double-click takes two numbers and returns an awaited input operation. */
import type { Browser } from '../../src/index.ts';

declare const browser: Browser;
void (browser.mouse.dblclick(120, 80) satisfies Promise<void>);
// @ts-expect-error both coordinates are required
void browser.mouse.dblclick(120);
// @ts-expect-error viewport coordinates must be numbers
void browser.mouse.dblclick('120', 80);
