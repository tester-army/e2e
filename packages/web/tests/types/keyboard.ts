/** Compile-time assertions for held keys: `browser.keyboard.down` and `up` take a key name. */
import type { Browser } from '../../src/index.ts';

declare const browser: Browser;
void (browser.keyboard.down('Shift') satisfies Promise<void>);
void (browser.keyboard.up('Shift') satisfies Promise<void>);
// @ts-expect-error key names must be strings
void browser.keyboard.down(42);
