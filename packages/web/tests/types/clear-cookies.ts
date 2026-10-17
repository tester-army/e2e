/** Compile-time assertions for `browser.clearCookies`: the filters it takes, each a string or RegExp. */
import type { Browser, CookieFilter } from '../../src/index.ts';

declare const browser: Browser;
const filter: CookieFilter = { name: /session/, domain: 'localhost', path: '/' };
void (browser.clearCookies(filter) satisfies Promise<void>);
void browser.clearCookies();
// @ts-expect-error filter values are strings or RegExps.
void browser.clearCookies({ name: 1 });
// @ts-expect-error `url` is not a filter.
void browser.clearCookies({ url: 'http://localhost' });
