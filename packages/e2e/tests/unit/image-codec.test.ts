/** `@napi-rs/image` loads when the first PNG is decoded or encoded, and a binding that is missing fails that call, and only that, as IMAGE_CODEC_UNAVAILABLE. */

import { registerHooks } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { downscalePixels } from '../../src/agent/pixels.ts';
import { InfrastructureError } from '../../src/internal/errors.ts';
import { clipBox, compareImages, cropImage, decodePng, encodePng, resampleImage, type RgbaImage } from '../../src/internal/image.ts';

// What the loader reports when npm left the binding out. This file imports nothing that loads the addon, so no earlier test in the process has.
let loaderFailure = new Error('Cannot find native binding. npm has a bug related to optional dependencies');
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@napi-rs/image') throw loaderFailure;
    return nextResolve(specifier, context);
  },
});
afterAll(() => hooks.deregister());

/** The error `run` throws; the test fails when it throws none. */
function failure(run: () => unknown): InfrastructureError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof InfrastructureError) return cause;
    throw cause;
  }
  throw new Error('expected a throw');
}

/** A width by height image of one gray level, built without the addon. */
function gray(width: number, height: number, level: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set([level, level, level, 255], at);
  return { width, height, data };
}

const BINDING = `@napi-rs/image-${process.platform}-${process.arch}`;
const exact = { threshold: 0, maxDiffPixels: undefined, maxDiffPixelRatio: undefined };

describe('without the @napi-rs/image binding', () => {
  it('fails a decode and an encode as IMAGE_CODEC_UNAVAILABLE, naming the binding and the way back', () => {
    for (const read of [() => decodePng(new Uint8Array(8)), () => encodePng(gray(1, 1, 0))]) {
      const error = failure(read);
      expect(error.code).toBe('IMAGE_CODEC_UNAVAILABLE');
      expect(error.category).toBe('infrastructure');
      expect(error.message).toContain(BINDING);
      expect(error.message).toContain('npm/cli#4828');
      expect(error.cause).toBe(loaderFailure);
    }
  });

  it('gives the loader error for a codec that fails to load for another reason', () => {
    loaderFailure = new Error('dlopen failed: bad ELF header\n    at Module._extensions');
    const error = failure(() => decodePng(new Uint8Array(8)));
    expect(error.message).toContain('it could not be loaded (dlopen failed: bad ELF header)');
    expect(error.message).not.toContain('--omit=optional');
  });

  it('fails a model-sized screenshot instead of passing the capture on', () => {
    const pixels = { data: new Uint8Array(8), mediaType: 'image/png', width: 2000, height: 1000, scale: 1 } as const;
    expect(failure(() => downscalePixels(pixels, 768)).code).toBe('IMAGE_CODEC_UNAVAILABLE');
    expect(downscalePixels(pixels, 2000)).toBe(pixels);
  });

  it('still runs the image operations that read no PNG', () => {
    const image = gray(8, 8, 90);
    expect(compareImages(image, gray(8, 8, 90), exact).kind).toBe('match');
    expect(compareImages(image, gray(8, 8, 200), exact).kind).toBe('pixels');
    expect(resampleImage(image, 4, 4).data.length).toBe(4 * 4 * 4);
    expect(cropImage(image, clipBox(image, { x: 2, y: 2, width: 3, height: 3 })!).width).toBe(3);
  });
});
