/** The BiDi `browser` fixture's own adapters: Playwright key names as WebDriver key sources, and `Set-Cookie` headers as cookies to store. */

import { describe, expect, it } from 'vitest';
import { setCookieOf } from '../../src/fixture/browser.ts';
import { fixtureKeyStroke, strokeSource, type KeyPhase } from '../../src/driver/keyboard.ts';

const SHIFT = '';

/** The BiDi key source of one `browser.keyboard` call, with Shift held before it or not. */
function fixtureKeySource(key: string, phase: KeyPhase, shiftHeld: boolean) {
  return strokeSource(fixtureKeyStroke(key, phase), shiftHeld);
}

describe('fixtureKeyStroke', () => {
  it('holds a bare modifier and upper-cases a letter while Shift is held', () => {
    expect(fixtureKeySource('Shift', 'keyDown', false).actions).toEqual([{ type: 'keyDown', value: SHIFT }]);
    expect(fixtureKeySource('KeyB', 'press', true).actions).toEqual([{ type: 'keyDown', value: 'B' }, { type: 'keyUp', value: 'B' }]);
    expect(fixtureKeySource('KeyB', 'press', false).actions).toEqual([{ type: 'keyDown', value: 'b' }, { type: 'keyUp', value: 'b' }]);
    expect(fixtureKeySource('Digit7', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: '7' });
    expect(fixtureKeySource('A', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: 'A' });
    expect(fixtureKeySource('a', 'press', true).actions[0]).toEqual({ type: 'keyDown', value: 'A' });
  });

  it('presses modifiers around the key of a combination, including the plus key itself', () => {
    expect(fixtureKeySource('Shift+KeyA', 'press', false).actions).toEqual([
      { type: 'keyDown', value: SHIFT },
      { type: 'keyDown', value: 'A' },
      { type: 'keyUp', value: 'A' },
      { type: 'keyUp', value: SHIFT },
    ]);
    expect(fixtureKeySource('Shift++', 'press', false).actions[1]).toEqual({ type: 'keyDown', value: '+' });
  });

  it('refuses a combination to hold, a non-modifier prefix, and an unknown name', () => {
    expect(() => fixtureKeySource('Shift+a', 'keyDown', false)).toThrow('keyboard.down cannot read the key "Shift+a"');
    expect(() => fixtureKeySource('a+b', 'press', false)).toThrow('"a" in "a+b" is not a modifier');
    expect(() => fixtureKeySource('Hyper', 'press', false)).toThrow('Unknown key: "Hyper"');
  });
});

describe('setCookieOf', () => {
  const url = new URL('https://app.test/account/settings');

  it('reads the attributes, with Max-Age over Expires and the default path from the URL', () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = setCookieOf('sid=abc=1; Domain=.app.test; Secure; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=60', url);
    expect(cookie).toMatchObject({ name: 'sid', value: { type: 'string', value: 'abc=1' }, domain: '.app.test', path: '/account', secure: true, httpOnly: true, sameSite: 'lax' });
    expect(cookie?.expiry).toBeGreaterThanOrEqual(now + 60);
    expect(setCookieOf('theme=dark; Path=/x', new URL('https://app.test/'))).toEqual({ name: 'theme', value: { type: 'string', value: 'dark' }, domain: 'app.test', path: '/x' });
  });

  it('refuses a Domain the response host does not belong to, and keeps a parent domain', () => {
    expect(setCookieOf('sid=x; Domain=app.test', new URL('https://other.test/'))).toBeUndefined();
    expect(setCookieOf('sid=x; Domain=evil-app.test', new URL('https://app.test/'))).toBeUndefined();
    expect(setCookieOf('sid=x; Domain=.app.test', new URL('https://api.app.test/'))).toMatchObject({ domain: '.app.test' });
  });

  it('skips a header with no name', () => {
    expect(setCookieOf('=orphan', url)).toBeUndefined();
    expect(setCookieOf('novalue', url)).toBeUndefined();
  });
});
