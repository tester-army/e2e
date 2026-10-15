/**
 * The screenshot a model receives, sized for it. Engines capture at CSS or
 * device scale; a 1280 by 720 web viewport or a 1170 by 2532 phone is more
 * image than a model needs to place a tap, and every image pixel is paid
 * for on every turn it stays in the conversation. The long side is capped
 * and the image resampled, and `scale` (image pixels per CSS pixel) is
 * reduced with it, so every coordinate a model reads off the image still
 * maps onto the viewport through the same arithmetic. Masked regions stay
 * masked: a box filter over black stays black.
 */

import type { ObservationPixels } from '../engine/surface.ts';
import { decodePng, encodePng, resampleImage, type RgbaImage } from '../internal/image.ts';

/**
 * Longest side a model-bound screenshot keeps, in image pixels. Measured on
 * gpt-5.6 over a ten-key drawn keypad and an eight-screen drawn wizard, four
 * runs per size: a 1280 by 720 capture costs about 1390 input tokens per
 * turn, 1024 about 960, 768 about 680, 640 about 580, 512 about 500. Every
 * size down to 640 passed every run; at 512 the model misread the keypad's
 * display, needed retries, and once accepted a wrong code. 768 keeps a full
 * step of margin above that cliff for 35% less per run than full size.
 */
const MAX_SCREENSHOT_LONG_SIDE = 768;

/** Sizes a captured screenshot for the model; the input is returned as is when it already fits. */
export function sizeForModel<P extends ObservationPixels>(pixels: P): P {
  return downscalePixels(pixels, MAX_SCREENSHOT_LONG_SIDE);
}

/**
 * Resamples the image so its longer side is at most `maxLongSide`, with a
 * box filter over the source pixels each target pixel covers. Returns the
 * input untouched when it already fits or cannot be decoded; whatever else
 * the caller's pixels carry (a masked-region count) rides along unchanged.
 */
export function downscalePixels<P extends ObservationPixels>(pixels: P, maxLongSide: number): P {
  const longSide = Math.max(pixels.width, pixels.height);
  if (longSide <= maxLongSide || maxLongSide <= 0) return pixels;
  const factor = maxLongSide / longSide;
  const width = Math.max(1, Math.round(pixels.width * factor));
  const height = Math.max(1, Math.round(pixels.height * factor));
  let source: RgbaImage;
  try {
    source = decodePng(pixels.data);
  } catch {
    return pixels;
  }
  const data = encodePng(resampleImage(source, width, height));
  return { ...pixels, data, width, height, scale: pixels.scale * (width / pixels.width) };
}
