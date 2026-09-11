/** Sizing a screenshot for the model: the cap, the scale arithmetic, and masks that stay black. */

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { ObservationPixels } from '../../src/engine/surface.ts';
import { downscalePixels } from '../../src/agent/pixels.ts';

/** A width by height PNG: white, with a black box at the given rect. */
function picture(width: number, height: number, box: { x: number; y: number; w: number; h: number }): ObservationPixels {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      png.data[at] = png.data[at + 1] = png.data[at + 2] = inBox ? 0 : 255;
      png.data[at + 3] = 255;
    }
  }
  return { data: new Uint8Array(PNG.sync.write(png)), mediaType: 'image/png', width, height, scale: 1 };
}

function pixelAt(pixels: ObservationPixels, x: number, y: number): number[] {
  const png = PNG.sync.read(Buffer.from(pixels.data));
  const at = (y * png.width + x) * 4;
  return [...png.data.subarray(at, at + 3)];
}

describe('downscalePixels', () => {
  it('returns the input untouched when the long side already fits', () => {
    const shot = picture(640, 360, { x: 0, y: 0, w: 10, h: 10 });
    expect(downscalePixels(shot, 640)).toBe(shot);
    expect(downscalePixels(shot, 0)).toBe(shot);
  });

  it('caps the long side, keeps the aspect, and scales the image-to-viewport ratio with it', () => {
    const shot = picture(1280, 720, { x: 0, y: 0, w: 10, h: 10 });
    const small = downscalePixels(shot, 640);
    expect([small.width, small.height]).toEqual([640, 360]);
    expect(small.scale).toBeCloseTo(0.5);
    expect(small.data.byteLength).toBeLessThan(shot.data.byteLength);
    // A device capture at 3x keeps its ratio meaning: image pixels per CSS pixel.
    const device = { ...picture(1170, 2532, { x: 0, y: 0, w: 10, h: 10 }), scale: 3 };
    const capped = downscalePixels(device, 1024);
    expect(capped.height).toBe(1024);
    expect(capped.scale).toBeCloseTo(3 * (capped.width / 1170));
  });

  it('keeps a masked region black after resampling, and the surroundings white', () => {
    const shot = picture(1280, 720, { x: 200, y: 200, w: 400, h: 200 });
    const small = downscalePixels(shot, 640);
    expect(pixelAt(small, 200, 150)).toEqual([0, 0, 0]);
    expect(pixelAt(small, 50, 50)).toEqual([255, 255, 255]);
  });
});
