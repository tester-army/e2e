import { PNG } from 'pngjs';
import type { ExecutorPixels } from 'e2e';
import { fnv1a } from './hash.ts';
/** Pixels as the decision model receives them: the runner's capture without its masking count. */
export type Screenshot = Omit<ExecutorPixels, 'maskedRegionCount'>;
/** A viewport point in CSS pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}
/**
 * A grid over an image: at most ten columns and rows, one score level per
 * column and row. Sizes are in the CSS pixels of the image's coordinates.
 */
export interface Grid {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}
/** The Decisions API scores at most ten levels per question. */
const MAX_LEVELS = 10;
/**
 * Target cell size of a first look in CSS pixels. A 1280 by 720 viewport
 * gets 10 columns of 128px and 9 rows of 80px; measured on gpt-6-luna over
 * a drawn keypad, the probability-weighted column and row land within a
 * column of every key.
 */
export const CELL_TARGET = 80;
/**
 * The grid for an image: as close to `cellTarget` CSS pixels per cell as
 * the level cap allows. A 1280 by 720 viewport with an 80px target gets 10
 * columns of 128px and 9 rows of 80px.
 */
export function gridFor(width: number, height: number, cellTarget: number): Grid {
  const columns = Math.min(MAX_LEVELS, Math.max(1, Math.round(width / cellTarget)));
  const rows = Math.min(MAX_LEVELS, Math.max(1, Math.round(height / cellTarget)));
  return { columns, rows, cellWidth: width / columns, cellHeight: height / rows };
}
/** The point a column and row score name on a grid: the center of the scored position, inside the image. */
export function pointOf(grid: Grid, column: number, row: number): Point {
  const clamp = (value: number, max: number): number => Math.min(max - 1, Math.max(0, Math.round(value)));
  return {
    x: clamp((column + 0.5) * grid.cellWidth, grid.columns * grid.cellWidth),
    y: clamp((row + 0.5) * grid.cellHeight, grid.rows * grid.cellHeight),
  };
}
/** A zoomed crop: the image, and where its top-left corner sits in the screenshot's CSS pixels. */
export interface Zoom {
  readonly screenshot: Screenshot;
  readonly origin: Point;
  readonly factor: number;
}
/**
 * The `box` by `box` CSS-pixel region around `center`, kept inside the
 * screenshot and enlarged `factor` times (nearest neighbor), for a finer
 * second look at a drawn control. Undefined when the pixels cannot be decoded.
 */
export function zoomAround(screenshot: Screenshot, center: Point, box: number, factor: number): Zoom | undefined {
  const png = decode(screenshot);
  if (png === undefined) return undefined;
  const scale = screenshot.scale;
  const cssWidth = png.width / scale;
  const cssHeight = png.height / scale;
  const side = Math.min(box, cssWidth, cssHeight);
  const origin = {
    x: Math.round(Math.max(0, Math.min(cssWidth - side, center.x - side / 2))),
    y: Math.round(Math.max(0, Math.min(cssHeight - side, center.y - side / 2))),
  };
  const size = Math.round(side * factor);
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(png.width - 1, Math.floor((origin.x + x / factor) * scale));
      const sy = Math.min(png.height - 1, Math.floor((origin.y + y / factor) * scale));
      const from = (sy * png.width + sx) * 4;
      const to = (y * size + x) * 4;
      out.data[to] = png.data[from] ?? 0;
      out.data[to + 1] = png.data[from + 1] ?? 0;
      out.data[to + 2] = png.data[from + 2] ?? 0;
      out.data[to + 3] = 255;
    }
  }
  return { screenshot: { mediaType: 'image/png', data: new Uint8Array(PNG.sync.write(out)), width: size, height: size, scale: 1 }, origin, factor };
}
/**
 * A hash of the `box` by `box` CSS-pixel region around `center`: what a tap
 * there changed, read without the rest of the page. Undefined without
 * pixels or when they cannot be decoded.
 */
export function regionHash(screenshot: Screenshot | undefined, center: Point, box: number): string | undefined {
  if (screenshot === undefined) return undefined;
  const zoom = zoomAround(screenshot, center, box, 1);
  return zoom === undefined ? undefined : fnv1a([zoom.screenshot.data]);
}
/**
 * The screenshot with the grid's cell borders drawn on it. Measured on
 * gpt-6-luna over a drawn keypad at the runner's 768px capture, the zoomed
 * look lands within 30px of every key with the lines, and a cell number
 * drawn in each corner only covered the glyphs it was meant to help find.
 * Returns the input untouched when it cannot be decoded.
 */
export function withGrid(screenshot: Screenshot, grid: Grid): Screenshot {
  const png = decode(screenshot);
  if (png === undefined) return screenshot;
  const scale = screenshot.scale;
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const x0 = Math.round(column * grid.cellWidth * scale);
      const y0 = Math.round(row * grid.cellHeight * scale);
      const x1 = Math.min(png.width, Math.round((column + 1) * grid.cellWidth * scale));
      const y1 = Math.min(png.height, Math.round((row + 1) * grid.cellHeight * scale));
      for (let x = x0; x < x1; x += 1) {
        paint(png, x, y0, GRID);
        paint(png, x, y1 - 1, GRID);
      }
      for (let y = y0; y < y1; y += 1) {
        paint(png, x0, y, GRID);
        paint(png, x1 - 1, y, GRID);
      }
    }
  }
  return { ...screenshot, data: new Uint8Array(PNG.sync.write(png)) };
}
function decode(screenshot: Screenshot): PNG | undefined {
  try {
    return PNG.sync.read(Buffer.from(screenshot.data));
  } catch {
    return undefined;
  }
}
const GRID: readonly [number, number, number] = [255, 0, 255];
function paint(png: PNG, x: number, y: number, color: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = 255;
}
