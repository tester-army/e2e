import { crc32, deflateSync } from 'node:zlib';
import { JsColorType, Transformer } from '@napi-rs/image';
/** PNG bytes of 8-bit RGBA pixels. */
export function pngOf(width: number, height: number, rgba: Uint8Array): Uint8Array {
  return new Uint8Array(Transformer.fromRgbaPixels(rgba, width, height).pngSync());
}
/** A white, opaque RGBA PNG. */
export function whitePng(width: number, height: number): Uint8Array {
  return pngOf(width, height, new Uint8Array(width * height * 4).fill(255));
}
/** The size and RGBA pixels of a PNG the package wrote, which is always 8-bit RGBA. */
export function rgbaOf(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const image = new Transformer(bytes);
  const { width, height, format, colorType } = image.metadataSync();
  if (format !== 'png') throw new Error(`expected a PNG, got ${format}`);
  if (colorType !== JsColorType.Rgba8) throw new Error(`expected an 8-bit RGBA PNG, got color type ${colorType}`);
  return { width, height, data: image.rawPixelsSync() };
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
 * A PNG written straight from the format, so a test can hand the package a
 * color type no encoder of its own would write: `rows` hold each scanline's
 * sample bytes as the color type and `depth` pack them, with no filter; an
 * indexed one names its `palette`.
 */
export function rawPng(width: number, height: number, depth: number, colorType: number, rows: readonly (readonly number[])[], palette?: readonly (readonly number[])[]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(palette === undefined ? [] : [chunk('PLTE', Buffer.from(palette.flat()))]),
    chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from([0, ...row]))))),
    chunk('IEND'),
  ]);
}
