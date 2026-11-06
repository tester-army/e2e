/**
 * The BiDi driver's config-load checks and its key and pointer encoding: what
 * `web({ driver: 'bidi' })` accepts, and the `input.performActions` sources
 * the contract's key grammar and gestures become. What the browser does with
 * them is covered by running the testbed with `E2E_WEB_DRIVER=bidi`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { web } from '../../src/index.ts';
import { clickSources, pressSource, typeSource } from '../../src/bidi/input.ts';

describe('web({ driver })', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a BiDi engine whose version names the driver', () => {
    expect(web({ driver: 'bidi' }).version).toMatch(/\+bidi$/);
    expect(web({ driver: 'playwright' }).version).not.toMatch(/\+bidi$/);
  });

  it('takes the driver from E2E_WEB_DRIVER when the option is unset, and the option wins', () => {
    vi.stubEnv('E2E_WEB_DRIVER', 'bidi');
    expect(web().version).toMatch(/\+bidi$/);
    expect(web({ driver: 'playwright' }).version).not.toMatch(/\+bidi$/);
  });

  it('refuses an unknown driver', () => {
    vi.stubEnv('E2E_WEB_DRIVER', 'cdp');
    expect(() => web()).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'E2E_WEB_DRIVER must be "playwright" or "bidi", got "cdp"' }));
  });

  it('refuses webkit and a persistent remote context, naming why', () => {
    expect(() => web({ driver: 'bidi', browser: 'webkit' })).toThrow(/drives chromium and firefox, got "webkit"; WebKit has no BiDi endpoint yet/);
    const cdpEndpoint = () => 'ws://127.0.0.1:9222';
    expect(() => web({ driver: 'bidi', connect: { cdpEndpoint, reconnectEndpoint: cdpEndpoint } })).toThrow(/does not ride a persistent remote context \(connect.reconnectEndpoint\)/);
  });

  it('takes the options the Playwright driver takes, validated the same way', () => {
    expect(() => web({ driver: 'bidi', locale: 'de-DE', timezoneId: 'Europe/Berlin', headers: { 'x-a': 'b' }, colorScheme: 'dark' })).not.toThrow();
    expect(() => web({ driver: 'bidi', headers: { 'x bad': 'b' } })).toThrow(/invalid header name/);
  });

  it('offers the browser fixture, saved sessions, and video', () => {
    const engine = web({ driver: 'bidi', browser: 'firefox' });
    expect(Object.keys(engine.fixtures ?? {})).toEqual(['browser']);
    expect(engine.state).toBeDefined();
    expect(engine.artifacts?.startVideo).toBeDefined();
  });
});

describe('BiDi input sources', () => {
  it('presses a named key with its modifiers held around it', () => {
    expect(pressSource('Shift+Tab').actions).toEqual([
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
