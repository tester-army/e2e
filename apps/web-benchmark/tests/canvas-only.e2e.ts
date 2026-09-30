import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { countColor, onCanvas, pixelAt } from './canvas.ts';

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

  test('taps square, circle, then diamond at their pixel coordinates', async ({ screen, browser }) => {
    await expect.poll(() => pixelAt(browser, FIRST_DOT)).toEqual(GREY);
    expect(await pixelAt(browser, SECOND_DOT)).toEqual(GREY);
    expect(await pixelAt(browser, THIRD_DOT)).toEqual(GREY);

    await screen.tapAt(await onCanvas(browser, CANVAS, SQUARE));
    await expect.poll(() => pixelAt(browser, FIRST_DOT)).toEqual(GREEN);
    await screen.tapAt(await onCanvas(browser, CANVAS, CIRCLE));
    await expect.poll(() => pixelAt(browser, SECOND_DOT)).toEqual(GREEN);
    await screen.tapAt(await onCanvas(browser, CANVAS, DIAMOND));
    await expect.poll(() => pixelAt(browser, THIRD_DOT)).toEqual(GREEN);
    await expect.poll(() => countColor(browser, STATUS_BAND, GREEN)).toBeGreaterThan(0);
  });

  test('a shape out of order paints the error and resets progress', async ({ screen, browser }) => {
    await screen.tapAt(await onCanvas(browser, CANVAS, SQUARE));
    await expect.poll(() => pixelAt(browser, FIRST_DOT)).toEqual(GREEN);

    await screen.tapAt(await onCanvas(browser, CANVAS, DIAMOND));
    await expect.poll(() => countColor(browser, STATUS_BAND, RED)).toBeGreaterThan(0);
    await expect.poll(() => pixelAt(browser, FIRST_DOT)).toEqual(GREY);
  });
});
