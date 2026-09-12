import { describe, expect, it } from 'vitest';
import { readPngSize, sanitizeFilename, screenLocation, swipeWithin } from '../../src/support.ts';

describe('support helpers', () => {
  it('reports the app and the screen title as a location that is not a URL', () => {
    expect(screenLocation('com.apple.Preferences', 'General')).toBe('com.apple.Preferences / General');
    expect(screenLocation('com.apple.Preferences', undefined)).toBe('com.apple.Preferences');
    expect(screenLocation(undefined, 'General')).toBe('General');
    expect(screenLocation(undefined, undefined)).toBeUndefined();
    expect(screenLocation('My App', ' Wi-Fi  Settings ')).toBe('My App / Wi-Fi Settings');
    // Two apps with a screen of the same name never share a location.
    expect(screenLocation('com.apple.Preferences', 'General')).not.toBe(screenLocation('com.example.other', 'General'));
    // The harness applies its origin policy to anything that parses as a URL; a device location must not.
    expect(URL.canParse(screenLocation('com.apple.Preferences', 'General')!)).toBe(false);
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
