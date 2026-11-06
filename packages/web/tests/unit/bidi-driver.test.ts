/**
 * The BiDi engine's config-load checks and its key and pointer encoding: what
 * `web()` accepts, and the `input.performActions` sources the contract's key
 * grammar and gestures become. What the browser does with them is covered by
 * the integration tests.
 */

import { describe, expect, it } from 'vitest';
import { web, type WebOptions } from '../../src/index.ts';
import { clickSources, typeSource } from '../../src/bidi/input.ts';
import { pressStroke, strokeSource } from '../../src/bidi/keyboard.ts';

describe('web()', () => {
  it('refuses the removed driver option and webkit, naming why', () => {
    expect(() => web({ driver: 'bidi' } as unknown as WebOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('unknown key "driver"') }));
    expect(() => web({ browser: 'webkit' } as unknown as WebOptions)).toThrow(/drives chromium or firefox over WebDriver BiDi, got "webkit"/);
  });

  it('validates the options it takes', () => {
    expect(() => web({ locale: 'de-DE', timezoneId: 'Europe/Berlin', headers: { 'x-a': 'b' }, colorScheme: 'dark' })).not.toThrow();
    expect(() => web({ headers: { 'x bad': 'b' } })).toThrow(/invalid header name/);
  });

  it('offers the browser fixture, saved sessions, and video', () => {
    const engine = web({ browser: 'firefox' });
    expect(Object.keys(engine.fixtures ?? {})).toEqual(['browser']);
    expect(engine.state).toBeDefined();
    expect(engine.artifacts?.startVideo).toBeDefined();
  });
});

describe('BiDi input sources', () => {
  it('presses a named key with its modifiers held around it', () => {
    expect(strokeSource(pressStroke('Shift+Tab'), false).actions).toEqual([
      { type: 'keyDown', value: '' },
      { type: 'keyDown', value: '' },
      { type: 'keyUp', value: '' },
      { type: 'keyUp', value: '' },
    ]);
  });

  it('types one grapheme per key, a newline as Enter', () => {
    expect(typeSource('a👍🏽\n').actions.map((action) => (action.type === 'pause' ? '' : action.value))).toEqual([
      'a', 'a', '👍🏽', '👍🏽', '', '',
    ]);
  });

  it('holds modifiers on a key source across every tick of the click', () => {
    const [keys, pointer] = clickSources(10, 20, { modifiers: ['Alt'] });
    expect(keys?.type).toBe('key');
    expect(keys?.actions[0]).toEqual({ type: 'keyDown', value: '\uE00A' });
    expect(keys?.actions.at(-1)).toEqual({ type: 'keyUp', value: '\uE00A' });
    // The release lands on the tick after the pointer's last.
    expect(keys?.actions).toHaveLength(pointer!.actions.length + 1);
    expect(pointer?.actions.filter((action) => action.type === 'pointerDown')).toHaveLength(1);
  });
});
