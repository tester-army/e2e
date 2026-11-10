import { crc32, deflateSync } from 'node:zlib';
import { FilterType, JsColorType, Transformer } from '@napi-rs/image';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Uint8Array;
}

/** Reads assertion pixels through the library, independently of the masking policy: RGB and RGBA PNGs, both as RGBA. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const image = new Transformer(bytes);
  const { width, height, format, colorType } = image.metadataSync();
  if (format !== 'png') throw new Error(`expected a PNG, got ${format}`);
  const raw = image.rawPixelsSync();
  if (colorType === JsColorType.Rgba8) return { width, height, channels: 4, pixels: raw };
  if (colorType !== JsColorType.Rgb8) throw new Error(`expected an RGB or RGBA PNG, got color type ${colorType}`);
  const pixels = new Uint8Array(width * height * 4);
  for (let from = 0, to = 0; from < raw.length; from += 3, to += 4) {
    pixels.set(raw.subarray(from, from + 3), to);
    pixels[to + 3] = 255;
  }
  return { width, height, channels: 4, pixels };
}

/** One PNG chunk: its length, type, data, and the CRC of type and data. */
function chunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * A PNG written straight from the format, so a test can hand the code under
 * test a color type no encoder of its own would write: `rows` hold each
 * scanline's sample bytes as the color type and `depth` pack them, with no filter.
 */
export function rawPng(width: number, height: number, depth: number, colorType: number, rows: readonly (readonly number[])[]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from([0, ...row]))))),
    chunk('IEND'),
  ]);
}

/** Encodes a synthetic screenshot in RGB or RGBA. An RGBA one takes a chosen PNG row filter; an RGB one is written unfiltered. */
export function encodePng(image: DecodedPng, filterType: FilterType = FilterType.Adaptive): Uint8Array {
  if (image.channels === 4) return new Uint8Array(Transformer.fromRgbaPixels(image.pixels, image.width, image.height).pngSync({ filterType }));
  const stride = image.width * 3;
  return rawPng(image.width, image.height, 8, 2, Array.from({ length: image.height }, (_, row) => [...image.pixels.subarray(row * stride, (row + 1) * stride)]));
}
