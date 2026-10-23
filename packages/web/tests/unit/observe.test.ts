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

  it('adopts the caret stylesheet before the screenshot and removes it after', async () => {
    const events: string[] = [];
    const evaluate = vi.fn(async (_work: unknown, argument: unknown) => {
      events.push(typeof argument === 'string' ? 'remove' : 'adopt');
      return 0;
    });
    const screenshot = vi.fn(async () => {
      events.push('screenshot');
      return Buffer.from(PNG_2X2);
    });
    const frame = { evaluate, locator: () => ({ count: async () => 0 }) };
    const page = { frames: () => [frame], screenshot } as unknown as Page;

    await capturePixels(page, operation, { width: 2, height: 2 });

    expect(events).toEqual(['adopt', 'screenshot', 'remove']);
  });

  it('removes the caret stylesheet when the screenshot fails', async () => {
    const events: string[] = [];
    const evaluate = vi.fn(async (_work: unknown, argument: unknown) => {
      events.push(typeof argument === 'string' ? 'remove' : 'adopt');
      return 0;
    });
    const screenshot = vi.fn(async () => {
      events.push('screenshot');
      throw new Error('capture failed');
    });
    const frame = { evaluate, locator: () => ({ count: async () => 0 }) };
    const page = { frames: () => [frame], screenshot } as unknown as Page;

    await expect(capturePixels(page, operation, { width: 2, height: 2 })).rejects.toThrow('capture failed');
    expect(events).toEqual(['adopt', 'screenshot', 'remove']);
  });
});
