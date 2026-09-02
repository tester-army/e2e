import { describe, expect, it } from 'vitest';
import { readPngSize, sanitizeFilename, screenUrl, swipeWithin } from '../../src/support.ts';

describe('support helpers', () => {
  it('mints a parseable app URL whose pathname carries the app identity and the screen title', () => {
    const url = new URL(screenUrl('com.apple.Preferences', 'General'));
    expect(url.protocol).toBe('app:');
    expect(url.host).toBe('device');
    expect(url.pathname).toBe('/com.apple.preferences/General');
    expect(new URL(screenUrl(undefined, undefined)).href).toBe('app://device/unknown/');
    expect(new URL(screenUrl('My App!', ' Wi-Fi  Settings ')).pathname).toBe('/my-app/Wi-Fi%20Settings');
    // Two apps with a screen of the same name never share a path.
    expect(new URL(screenUrl('com.apple.Preferences', 'General')).pathname).not.toBe(
      new URL(screenUrl('com.example.other', 'General')).pathname,
    );
  });

  it('swipes against the scroll direction inside the rect', () => {
    const rect = { x: 0, y: 100, width: 200, height: 400 };
    expect(swipeWithin(rect, 'down', undefined)).toEqual({ from: { x: 100, y: 400 }, to: { x: 100, y: 200 } });
    expect(swipeWithin(rect, 'up', 'fast')).toEqual({ from: { x: 100, y: 140 }, to: { x: 100, y: 460 } });
    expect(swipeWithin(rect, 'right', 'slow')).toEqual({ from: { x: 125, y: 300 }, to: { x: 75, y: 300 } });
    expect(swipeWithin(rect, 'left', undefined)).toEqual({ from: { x: 50, y: 300 }, to: { x: 150, y: 300 } });
  });

  it('reads PNG dimensions and refuses other bytes', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 390);
    new DataView(png.buffer).setUint32(20, 844);
    expect(readPngSize(png)).toEqual({ width: 390, height: 844 });
    expect(readPngSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(readPngSize(new Uint8Array(24))).toBeUndefined();
  });

  it('constrains labels to safe filenames', () => {
    expect(sanitizeFilename('after checkout/1')).toBe('after_checkout_1');
    expect(sanitizeFilename('')).toBe('artifact');
    expect(sanitizeFilename('x'.repeat(100))).toHaveLength(64);
  });
});
