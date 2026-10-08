import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { gridCells, withGrid, zoomAround } from '../src/overlay.ts';

/** A white PNG of the given size as the executor's screenshot. */
function white(width: number, height: number, scale = 1) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return { mediaType: 'image/png' as const, data: new Uint8Array(PNG.sync.write(png)), width, height, scale };
}
function pixel(data: Uint8Array, x: number, y: number): number[] {
  const png = PNG.sync.read(Buffer.from(data));
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 3)];
}
describe('withGrid', () => {
  it('draws cell borders and a numbered label plate on the screenshot', () => {
    const cells = new Map([['p1', { x: [0, 100] as const, y: [0, 80] as const }], ['p2', { x: [100, 200] as const, y: [0, 80] as const }]]);
    const out = withGrid(white(200, 80), cells);
    expect(out.width).toBe(200);
    expect(pixel(out.data, 50, 0)).toEqual([255, 0, 255]);
    expect(pixel(out.data, 100, 40)).toEqual([255, 0, 255]);
    expect(pixel(out.data, 2, 2)).toEqual([0, 0, 0]);
    expect(pixel(out.data, 150, 40)).toEqual([255, 255, 255]);
  });
  it('scales borders with the image scale', () => {
    const out = withGrid(white(400, 160, 2), new Map([['p1', { x: [0, 100] as const, y: [0, 80] as const }]]));
    expect(pixel(out.data, 199, 100)).toEqual([255, 0, 255]);
    expect(pixel(out.data, 300, 100)).toEqual([255, 255, 255]);
  });
  it('returns pixels it cannot decode untouched', () => {
    const screenshot = { mediaType: 'image/png' as const, data: new Uint8Array([1, 2, 3]), width: 1, height: 1, scale: 1 };
    expect(withGrid(screenshot, new Map([['p1', { x: [0, 1] as const, y: [0, 1] as const }]]))).toBe(screenshot);
  });
});

describe('zoomAround', () => {
  it('crops a box around the point, kept inside the image, and enlarges it', () => {
    const zoom = zoomAround(white(400, 300), { x: 390, y: 10 }, 100, 2);
    expect(zoom).toMatchObject({ origin: { x: 300, y: 0 }, factor: 2 });
    expect(zoom?.screenshot).toMatchObject({ width: 200, height: 200, scale: 1 });
    expect(pixel(zoom?.screenshot.data ?? new Uint8Array(), 100, 100)).toEqual([255, 255, 255]);
  });
  it('maps a scaled screenshot back to CSS pixels', () => {
    const zoom = zoomAround(white(800, 600, 2), { x: 200, y: 150 }, 100, 2);
    expect(zoom?.origin).toEqual({ x: 150, y: 100 });
    expect(zoom?.screenshot.width).toBe(200);
  });
  it('returns nothing for pixels it cannot decode', () => {
    expect(zoomAround({ mediaType: 'image/png', data: new Uint8Array([1]), width: 1, height: 1, scale: 1 }, { x: 0, y: 0 }, 10, 2)).toBeUndefined();
  });
});
describe('gridCells', () => {
  it('numbers cells row by row', () => {
    const cells = gridCells(200, 100, 2, 2);
    expect([...cells.entries()]).toEqual([
      ['p1', { x: [0, 100], y: [0, 50] }],
      ['p2', { x: [100, 200], y: [0, 50] }],
      ['p3', { x: [0, 100], y: [50, 100] }],
      ['p4', { x: [100, 200], y: [50, 100] }],
    ]);
  });
});
