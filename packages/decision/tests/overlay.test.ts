import { describe, expect, it } from 'vitest';
import { gridFor, pointOf, regionHash, withGrid, zoomAround } from '../src/overlay.ts';
import { pngOf, rawPng, rgbaOf, whitePng } from './png-helpers.ts';

/** A white PNG of the given size as the executor's screenshot. */
function white(width: number, height: number, scale = 1) {
  return { mediaType: 'image/png' as const, data: whitePng(width, height), width, height, scale };
}
function pixel(data: Uint8Array, x: number, y: number): number[] {
  const png = rgbaOf(data);
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 3)];
}
/** A 4 by 4 screenshot whose every pixel has the same `samples`, written as the color type and bit depth say; an indexed one names its `palette`. */
function filled(depth: number, colorType: number, samples: readonly number[], palette?: readonly (readonly number[])[]) {
  const row = Array.from({ length: 4 }, () => samples).flat();
  return { mediaType: 'image/png' as const, data: rawPng(4, 4, depth, colorType, Array.from({ length: 4 }, () => row), palette), width: 4, height: 4, scale: 1 };
}
describe('gridFor', () => {
  it('fits at most ten columns and rows near the target cell size', () => {
    expect(gridFor(1280, 720, 80)).toEqual({ columns: 10, rows: 9, cellWidth: 128, cellHeight: 80 });
    expect(gridFor(800, 600, 80)).toEqual({ columns: 10, rows: 8, cellWidth: 80, cellHeight: 75 });
    expect(gridFor(50, 50, 80)).toEqual({ columns: 1, rows: 1, cellWidth: 50, cellHeight: 50 });
  });
  it('names the center of a scored position, inside the image', () => {
    const grid = gridFor(800, 600, 80);
    expect(pointOf(grid, 2.5, 3)).toEqual({ x: 240, y: 263 });
    expect(pointOf(grid, 20, -5)).toEqual({ x: 799, y: 0 });
  });
});
describe('withGrid', () => {
  it('draws cell borders on the screenshot and nothing else', () => {
    const out = withGrid(white(200, 80), { columns: 2, rows: 1, cellWidth: 100, cellHeight: 80 });
    expect(out.width).toBe(200);
    expect(pixel(out.data, 50, 0)).toEqual([255, 0, 255]);
    expect(pixel(out.data, 100, 40)).toEqual([255, 0, 255]);
    expect(pixel(out.data, 2, 2)).toEqual([255, 255, 255]);
    expect(pixel(out.data, 150, 40)).toEqual([255, 255, 255]);
  });
  it('scales borders with the image scale', () => {
    const out = withGrid(white(400, 160, 2), { columns: 2, rows: 1, cellWidth: 100, cellHeight: 80 });
    expect(pixel(out.data, 199, 100)).toEqual([255, 0, 255]);
    expect(pixel(out.data, 300, 100)).toEqual([255, 255, 255]);
  });
  it('returns pixels it cannot decode untouched', () => {
    const screenshot = { mediaType: 'image/png' as const, data: new Uint8Array([1, 2, 3]), width: 1, height: 1, scale: 1 };
    expect(withGrid(screenshot, { columns: 1, rows: 1, cellWidth: 1, cellHeight: 1 })).toBe(screenshot);
  });
});
describe('every PNG color type', () => {
  const shots = [
    ['RGB', filled(8, 2, [10, 20, 30]), [10, 20, 30]],
    ['palette', filled(8, 3, [1], [[255, 0, 0], [10, 20, 30]]), [10, 20, 30]],
    ['gray', filled(8, 0, [200]), [200, 200, 200]],
    ['gray with alpha', filled(8, 4, [200, 128]), [200, 200, 200]],
    ['16-bit RGB', filled(16, 2, [255, 255, 128, 0, 1, 1]), [255, 128, 1]],
    ['16-bit RGBA', filled(16, 6, [0, 0, 255, 255, 0, 0, 255, 255]), [0, 255, 0]],
  ] as const;
  it.each(shots)('reads a %s screenshot into the grid and the zoom', (_label, shot, rgb) => {
    const grid = withGrid(shot, { columns: 1, rows: 1, cellWidth: 4, cellHeight: 4 });
    expect(pixel(grid.data, 0, 0)).toEqual([255, 0, 255]);
    expect(pixel(grid.data, 1, 1)).toEqual(rgb);
    const zoom = zoomAround(shot, { x: 2, y: 2 }, 4, 1);
    expect(zoom?.screenshot).toMatchObject({ width: 4, height: 4 });
    expect(pixel(zoom?.screenshot.data ?? new Uint8Array(), 1, 1)).toEqual(rgb);
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
  it('returns nothing for a region under one pixel, which no PNG can hold', () => {
    expect(zoomAround(white(1, 1, 4), { x: 0, y: 0 }, 10, 1)).toBeUndefined();
  });
});
describe('regionHash', () => {
  it('changes only when the region around the point changes', () => {
    const base = white(400, 300);
    const dot = white(400, 300);
    const png = rgbaOf(dot.data);
    png.data[(10 * 400 + 10) * 4] = 0;
    const dotted = { ...dot, data: pngOf(400, 300, png.data) };
    expect(regionHash(base, { x: 20, y: 20 }, 50)).not.toBe(regionHash(dotted, { x: 20, y: 20 }, 50));
    expect(regionHash(base, { x: 350, y: 250 }, 50)).toBe(regionHash(dotted, { x: 350, y: 250 }, 50));
    expect(regionHash(undefined, { x: 0, y: 0 }, 50)).toBeUndefined();
  });
});
