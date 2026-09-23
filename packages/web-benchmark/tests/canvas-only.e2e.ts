import { test } from '@e2edev/web';
import { expect } from 'e2e';
import { countColor, onCanvas, pixelAt } from './canvas.ts';

// Everything is painted on one aria-hidden canvas: the shapes are tapped at
// their canvas coordinates and the outcome is read back from the pixels.
const CANVAS = { width: 480, height: 360 };
const SQUARE = { x: 90, y: 210 };
const CIRCLE = { x: 240, y: 210 };
const DIAMOND = { x: 390, y: 210 };
const FIRST_DOT = { x: 210, y: 100 };
const SECOND_DOT = { x: 240, y: 100 };
const THIRD_DOT = { x: 270, y: 100 };
const STATUS_BAND = { x: 0, y: 296, width: 480, height: 36 };
const GREEN = [0, 170, 0];
const RED = [204, 0, 0];
const GREY = [204, 204, 204];

test.describe('canvas only', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/canvas-only');
  });

  test('taps square, circle, then diamond at their pixel coordinates', async ({ screen, web }) => {
    await expect.poll(() => pixelAt(web, FIRST_DOT)).toEqual(GREY);
    expect(await countColor(web, STATUS_BAND, GREEN)).toBe(0);

    await screen.tapAt(await onCanvas(web, CANVAS, SQUARE));
    await expect.poll(() => pixelAt(web, FIRST_DOT)).toEqual(GREEN);
    await screen.tapAt(await onCanvas(web, CANVAS, CIRCLE));
    await expect.poll(() => pixelAt(web, SECOND_DOT)).toEqual(GREEN);
    await screen.tapAt(await onCanvas(web, CANVAS, DIAMOND));
    await expect.poll(() => pixelAt(web, THIRD_DOT)).toEqual(GREEN);
    await expect.poll(() => countColor(web, STATUS_BAND, GREEN)).toBeGreaterThan(0);
  });

  test('a shape out of order paints the error and resets progress', async ({ screen, web }) => {
    await screen.tapAt(await onCanvas(web, CANVAS, SQUARE));
    await expect.poll(() => pixelAt(web, FIRST_DOT)).toEqual(GREEN);

    await screen.tapAt(await onCanvas(web, CANVAS, DIAMOND));
    await expect.poll(() => countColor(web, STATUS_BAND, RED)).toBeGreaterThan(0);
    await expect.poll(() => pixelAt(web, FIRST_DOT)).toEqual(GREY);
  });
});
