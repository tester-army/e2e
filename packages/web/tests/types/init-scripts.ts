/** Compile-time assertions for `browser.addInitScript`: the scripts it takes, and an argument only beside a function. */
import type { Browser } from '../../src/index.ts';

declare const browser: Browser;
void browser.addInitScript('window.x = 1');
void browser.addInitScript({ path: 'shim.js' });
void browser.addInitScript(() => undefined);
void browser.addInitScript((wallet) => wallet.address.length, { address: '0xabc' });

// @ts-expect-error an argument goes to a function only.
void browser.addInitScript('window.x = 1', { a: 1 });
// @ts-expect-error the argument must be JSON-safe.
void browser.addInitScript((arg: Date) => arg, new Date());
// @ts-expect-error a function that takes an argument needs one.
void browser.addInitScript((arg: { a: number }) => arg.a);
