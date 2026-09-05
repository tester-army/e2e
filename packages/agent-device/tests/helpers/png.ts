import { PNG } from 'pngjs';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Uint8Array;
}

/** Reads assertion pixels through the library, independently of the masking policy. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const image = PNG.sync.read(Buffer.from(bytes));
  return { width: image.width, height: image.height, channels: 4, pixels: image.data };
}

/** Encodes a synthetic screenshot in RGB or RGBA, with a chosen PNG row filter. */
export function encodePng(image: DecodedPng, filterType = -1): Uint8Array {
  return PNG.sync.write({ width: image.width, height: image.height, data: Buffer.from(image.pixels) } as PNG, {
    inputColorType: image.channels === 3 ? 2 : 6,
    colorType: image.channels === 3 ? 2 : 6,
    inputHasAlpha: image.channels === 4,
    filterType,
  });
}
