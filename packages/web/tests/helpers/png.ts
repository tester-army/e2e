import { JsColorType, Transformer } from '@napi-rs/image';

/** Decodes screenshot pixels for assertions: an RGB or an RGBA PNG, the two a browser writes. */
export function decodePng(bytes: Uint8Array) {
  const image = new Transformer(bytes);
  const { width, height, format, colorType } = image.metadataSync();
  if (format !== 'png') throw new Error(`expected a PNG, got ${format}`);
  const data = image.rawPixelsSync();
  const channels = colorType === JsColorType.Rgba8 ? 4 : colorType === JsColorType.Rgb8 ? 3 : undefined;
  if (channels === undefined) throw new Error(`expected an RGB or RGBA PNG, got color type ${colorType}`);
  return {
    width,
    height,
    pixelAt(x: number, y: number): readonly [number, number, number, number] {
      const at = (y * width + x) * channels;
      return [data[at]!, data[at + 1]!, data[at + 2]!, channels === 4 ? data[at + 3]! : 255];
    },
  };
}
