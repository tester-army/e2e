import { describe, expect, it } from 'vitest';
import { readPngSize } from '../../src/observe.ts';

/** A 2x2 PNG; only its IHDR header matters to these tests. */
const PNG_2X2 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWP4z8DAwMgABYNKAAAeAAHUL6H5AAAAAElFTkSuQmCC',
  ),
  (character) => character.charCodeAt(0),
);

describe('readPngSize', () => {
  it('reads dimensions out of the image bytes', () => {
    expect(readPngSize(PNG_2X2)).toEqual({ width: 2, height: 2 });
  });

  it('returns null for truncated bytes and non-PNG data', () => {
    expect(readPngSize(PNG_2X2.slice(0, 20))).toBeNull();
    expect(readPngSize(new Uint8Array(64))).toBeNull();
  });
});
