import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { countColor, onCanvas, pixelAt } from './canvas.ts';

// The whiteboard is one aria-hidden canvas: shapes are dragged by pointer path
// at canvas coordinates and every outcome is read back from the pixels. The
// page squeezes the 640px canvas into a 592px column, so x and y scale apart.
const CANVAS = { width: 640, height: 440 };
const RECT_HOME = { x: 105, y: 165 };
const RECT_SLOT = { x: 475, y: 165 };
const CIRCLE_HOME = { x: 105, y: 320 };
const CIRCLE_SLOT = { x: 475, y: 320 };
const SAVE_BUTTON = { x: 570, y: 28 };
const SAVE_BUTTON_EDGE = { x: 525, y: 28 };
const BANNER_BAND = { x: 0, y: 400, width: 640, height: 36 };
const BLUE = [37, 99, 235];
const ORANGE = [234, 88, 12];
const GREEN = [0, 170, 0];
const RED = [204, 0, 0];
const WHITE = [255, 255, 255];
const INACTIVE = [221, 221, 221];

test.describe('canvas whiteboard', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/canvas-whiteboard');
  });

  test('drags both shapes into their slots and saves', async ({ screen, browser }) => {
    await expect.poll(() => pixelAt(browser, RECT_HOME)).toEqual(BLUE);
    expect(await pixelAt(browser, RECT_SLOT)).toEqual(WHITE);
    expect(await pixelAt(browser, CIRCLE_SLOT)).toEqual(WHITE);

    await screen.swipe({ from: await onCanvas(browser, CANVAS, RECT_HOME), to: await onCanvas(browser, CANVAS, RECT_SLOT) });
    await expect.poll(() => pixelAt(browser, RECT_SLOT)).toEqual(BLUE);

    await screen.swipe({
      from: await onCanvas(browser, CANVAS, CIRCLE_HOME),
      to: await onCanvas(browser, CANVAS, CIRCLE_SLOT),
    });
    await expect.poll(() => pixelAt(browser, CIRCLE_SLOT)).toEqual(ORANGE);
    await expect.poll(() => pixelAt(browser, SAVE_BUTTON_EDGE)).toEqual(BLUE);

    await screen.tapAt(await onCanvas(browser, CANVAS, SAVE_BUTTON));
    await expect.poll(() => countColor(browser, BANNER_BAND, GREEN)).toBeGreaterThan(0);
    await expect.poll(() => pixelAt(browser, SAVE_BUTTON_EDGE)).toEqual(INACTIVE);
  });

  test('bounces a shape off the wrong slot and refuses to save early', async ({ screen, browser }) => {
    await screen.swipe({ from: await onCanvas(browser, CANVAS, RECT_HOME), to: await onCanvas(browser, CANVAS, CIRCLE_SLOT) });
    await expect.poll(() => countColor(browser, BANNER_BAND, RED)).toBeGreaterThan(0);
    expect(await pixelAt(browser, RECT_HOME)).toEqual(BLUE);
    expect(await pixelAt(browser, CIRCLE_SLOT)).toEqual(WHITE);

    await screen.tapAt(await onCanvas(browser, CANVAS, SAVE_BUTTON));
    await expect.poll(() => pixelAt(browser, SAVE_BUTTON_EDGE)).toEqual(INACTIVE);
    await expect.poll(() => countColor(browser, BANNER_BAND, RED)).toBeGreaterThan(0);
  });
});
