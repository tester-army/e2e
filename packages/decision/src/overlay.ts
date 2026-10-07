import { PNG } from 'pngjs';
import type { Cell } from './elements.ts';
import type { Screenshot } from './questions.ts';
/**
 * The screenshot with the `tap_at` grid drawn on it: cell borders and each
 * cell's number in its top-left corner, so a choice model can name the cell
 * holding a drawn control by reading the number off the image. Returns the
 * input untouched when it cannot be decoded.
 */
export function withGrid(screenshot: Screenshot, cells: ReadonlyMap<string, Cell>): Screenshot {
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(screenshot.data));
  } catch {
    return screenshot;
  }
  const scale = screenshot.scale;
  for (const [key, cell] of cells) {
    const x0 = Math.round(cell.x[0] * scale);
    const y0 = Math.round(cell.y[0] * scale);
    const x1 = Math.min(png.width, Math.round(cell.x[1] * scale));
    const y1 = Math.min(png.height, Math.round(cell.y[1] * scale));
    for (let x = x0; x < x1; x += 1) {
      paint(png, x, y0, GRID);
      paint(png, x, y1 - 1, GRID);
    }
    for (let y = y0; y < y1; y += 1) {
      paint(png, x0, y, GRID);
      paint(png, x1 - 1, y, GRID);
    }
    drawLabel(png, x0 + 2, y0 + 2, key.replace(/\D/g, ''), Math.max(1, Math.round(2 * scale)));
  }
  const data = new Uint8Array(PNG.sync.write(png));
  return { ...screenshot, data };
}
const GRID: readonly [number, number, number] = [255, 0, 255];
const INK: readonly [number, number, number] = [255, 255, 255];
const PLATE: readonly [number, number, number] = [0, 0, 0];
/** 3 by 5 glyphs for the digits, one row per string. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};
/** Draws `text` at (x, y) in white on a black plate, each glyph pixel `size` image pixels wide. */
function drawLabel(png: PNG, x: number, y: number, text: string, size: number): void {
  const width = text.length * 4 * size + size;
  const height = 5 * size + 2 * size;
  for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) paint(png, x + dx, y + dy, PLATE);
  for (const [position, character] of [...text].entries()) {
    const glyph = GLYPHS[character];
    if (glyph === undefined) continue;
    for (const [row, line] of glyph.entries()) {
      for (const [column, bit] of [...line].entries()) {
        if (bit !== '1') continue;
        for (let dy = 0; dy < size; dy += 1) {
          for (let dx = 0; dx < size; dx += 1) {
            paint(png, x + size + position * 4 * size + column * size + dx, y + size + row * size + dy, INK);
          }
        }
      }
    }
  }
}
function paint(png: PNG, x: number, y: number, color: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = 255;
}
