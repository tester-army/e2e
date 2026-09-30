/**
 * Pixel reads for the canvas scenarios, whose state lives in paint only: a
 * point in canvas pixels mapped to the viewport through the element's box,
 * the colour of one pixel, and how many pixels of a band hold one colour.
 */

import type { Browser } from '@e2e-dev/web';
import type { Point } from 'e2e';

export type Band = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** Maps a point in canvas pixels to the viewport through the canvas's current box. */
export async function onCanvas(browser: Browser, size: Size, point: Point): Promise<Point> {
  const box = await browser.locator('canvas').boundingBox();
  if (box === null) throw new Error('the canvas has no box');
  return {
    x: box.x + (point.x * box.width) / size.width,
    y: box.y + (point.y * box.height) / size.height,
  };
}

/** Reads one canvas pixel as `[r, g, b]`; the page keeps this state in paint only. */
export function pixelAt(browser: Browser, point: Point): Promise<number[]> {
  return browser.evaluate(
    (at: { x: number; y: number }) => {
      const context = document.querySelector('canvas')?.getContext('2d');
      if (!context) throw new Error('no canvas context');
      return Array.from(context.getImageData(at.x, at.y, 1, 1).data.slice(0, 3));
    },
    { x: point.x, y: point.y },
  );
}

/** Counts the canvas pixels painted exactly `color` inside a canvas-space band. */
export function countColor(browser: Browser, band: Band, color: number[]): Promise<number> {
  return browser.evaluate(
    (input: { band: Band; color: number[] }) => {
      const context = document.querySelector('canvas')?.getContext('2d');
      if (!context) throw new Error('no canvas context');
      const { x, y, width, height } = input.band;
      const [r, g, b] = input.color;
      const { data } = context.getImageData(x, y, width, height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === r && data[i + 1] === g && data[i + 2] === b) count += 1;
      }
      return count;
    },
    { band, color },
  );
}
