import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { capturePixels, readPngSize } from '../../src/observe.ts';

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

describe('capturePixels', () => {
  const operation = {
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    runId: 'run',
    attemptId: 'attempt',
    origin: 'agent',
  } as const;

  it('leaves the caret to the adopted stylesheet instead of editing element styles', async () => {
    const screenshot = vi.fn(async (_options: Record<string, unknown>) => Buffer.from(PNG_2X2));
    const page = { frames: () => [], screenshot } as unknown as Page;

    const capture = await capturePixels(page, operation, { width: 2, height: 2 });

    expect(capture.pixels).toMatchObject({ width: 2, height: 2, mediaType: 'image/png', scale: 1 });
    const options = screenshot.mock.calls[0]?.[0];
    expect(options).toMatchObject({ type: 'png', scale: 'css', animations: 'disabled', caret: 'initial' });
    expect(options?.style).toBeUndefined();
    expect(options?.mask).toBeUndefined();
  });
});
