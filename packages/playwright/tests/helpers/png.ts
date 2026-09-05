import { PNG } from 'pngjs';

/** Decodes screenshot pixels for assertions. */
export function decodePng(bytes: Uint8Array) {
  const { width, height, data } = PNG.sync.read(Buffer.from(bytes));
  return {
    width,
    height,
    pixelAt(x: number, y: number): readonly [number, number, number, number] {
      const at = (y * width + x) * 4;
      return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
    },
  };
}
