/**
 * The e2e wordmark: `e2e` set in Stack Sans Notch, the TesterArmy display
 * face, drawn in quadrant blocks in the terminal's own foreground the way the
 * site sets it in white on dark, with the brand orange as the accent. On a
 * terminal that can show it the letters drop in as orange blocks, the way the
 * pi installer builds its mark: the pieces stack on a floor row, the row fills, flashes, and clears,
 * the word drops into place, pulses twice, and settles into the foreground.
 * Where motion does not belong it is printed at rest, and output that is not
 * a terminal never sees it.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { envFlag } from '../internal/env.ts';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/**
 * The word as pixels: Stack Sans Notch at weight 400, rasterized twenty
 * pixels tall with two pixels per terminal column, a pixel lit when at least
 * half of it is covered, the glyphs set four columns apart. Each lit pixel
 * names its glyph, so the pieces fall letter by letter. A terminal cell holds
 * two pixel rows and two pixel columns, drawn as a quadrant block.
 */
const BITMAP: readonly string[] = [
  '...............................................222222222222...............................................',
  '...........................................2222222222222222222............................................',
  '.........................................22222222222222222222222..........................................',
  '........................................2222222...........2222222.........................................',
  '.........1111111111111.................2222222..............222222..................3333333333333.........',
  '......1111111111111111111.............2222222...............2222222..............3333333333333333333......',
  '....11111111111111111111111............22222................2222222............33333333333333333333333....',
  '..11111111...........1111111................................222222...........33333333...........3333333...',
  '.1111111...............111111.............................22222222..........3333333...............333333..',
  '.111111................111111..........................222222222............333333................333333..',
  '111111111111111111111111111111.....................22222222222.............333333333333333333333333333333.',
  '......111111111111111111111111..................22222222222......................333333333333333333333333.',
  '......111111111111111111111111...............2222222222..........................333333333333333333333333.',
  '111111....................................2222222222.......................333333.........................',
  '.111111..................................22222222...........................333333........................',
  '.1111111...............111111...........2222222.............................3333333...............333333..',
  '..11111111...........1111111...........2222222...............................33333333...........3333333...',
  '....11111111111111111111111...........22222222222222222222222222222............33333333333333333333333....',
  '......1111111111111111111....................2222222222222222222222..............3333333333333333333......',
  '..........11111111111........................222222222222222222222...................33333333333..........',
];
const GLYPHS = ['1', '2', '3'] as const;

/** Pixel columns per terminal column, and pixel rows per terminal row. */
const PIXELS_PER_CELL = 2;
const BITMAP_WIDTH_PX = BITMAP[0]!.length;
/** Columns the wordmark takes; a narrower terminal gets no wordmark. */
const WORDMARK_WIDTH = BITMAP_WIDTH_PX / PIXELS_PER_CELL;
const WORDMARK_PX = BITMAP.length;
/** Pixel rows above the word a piece falls through before it enters. */
const HEADROOM_PX = 4;
/** The floor row the pieces stack on, taken away by the clear. */
const FLOOR_PX = 2;
/** Pixel rows of the board while the pieces fall: headroom, word, floor. */
const BOARD_PX = HEADROOM_PX + WORDMARK_PX + FLOOR_PX;
const FLOOR_TOP = HEADROOM_PX + WORDMARK_PX;
/** Each glyph falls as three pieces, cut along these pixel rows of the bitmap, top to bottom. */
const BANDS: readonly (readonly [top: number, bottom: number])[] = [
  [0, 5],
  [6, 13],
  [14, 19],
];

const FRAME_MS = 33;
/** One piece starts falling every `STAGGER_MS`; each takes `FALL_MS` and glows for `GLOW_MS` on landing. */
const STAGGER_MS = 60;
const FALL_MS = 240;
const GLOW_MS = 90;
/** The full floor row flashes twice, clears, and the word drops one row over two frames. */
const ROW_FLASH_MS = 70;
const DROP_MS = 2 * FRAME_MS;
/** The settled word pulses twice between orange and the terminal's own foreground, and stays in the foreground. */
const PULSE_MS = 90;

interface Pixel {
  readonly x: number;
  readonly y: number;
}

interface Piece {
  /** The piece's pixels on the board, at their landed position before the clear. */
  readonly pixels: readonly Pixel[];
  /** Milliseconds into the drop when the piece starts to fall. */
  readonly start: number;
}

/** The glyph's lit pixels between two bitmap rows, placed on the board. */
function glyphPixels(glyph: string, top: number, bottom: number): Pixel[] {
  const pixels: Pixel[] = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < BITMAP_WIDTH_PX; x++) {
      if (BITMAP[y]![x] === glyph) pixels.push({ x, y: y + HEADROOM_PX });
    }
  }
  return pixels;
}

/** The columns a glyph spans, inclusive. */
function glyphSpan(glyph: string): readonly [left: number, right: number] {
  const columns = BITMAP.flatMap((row) => [...row].flatMap((cell, x) => (cell === glyph ? [x] : [])));
  return [Math.min(...columns), Math.max(...columns)];
}

/** The floor row under the columns `left` through `right`. */
function floorPixels(left: number, right: number): Pixel[] {
  const pixels: Pixel[] = [];
  for (let y = FLOOR_TOP; y < BOARD_PX; y++) {
    for (let x = left; x <= right; x++) pixels.push({ x, y });
  }
  return pixels;
}

/**
 * Every piece in drop order. The letters build up together, one band round
 * at a time from the bottom, each bottom piece carrying its glyph's stretch
 * of the floor; last come the fillers for the gaps between the letters,
 * which complete the floor row.
 */
const PIECES: readonly Piece[] = (() => {
  const spans = GLYPHS.map(glyphSpan);
  const pieces: Pixel[][] = [];
  for (let band = BANDS.length - 1; band >= 0; band--) {
    const [top, bottom] = BANDS[band]!;
    GLYPHS.forEach((glyph, index) => {
      const pixels = glyphPixels(glyph, top, bottom);
      if (band === BANDS.length - 1) pixels.push(...floorPixels(...spans[index]!));
      if (pixels.length > 0) pieces.push(pixels);
    });
  }
  for (let index = 1; index < spans.length; index++) {
    const left = spans[index - 1]![1] + 1;
    const right = spans[index]![0] - 1;
    if (left <= right) pieces.push(floorPixels(left, right));
  }
  return pieces.map((pixels, position) => ({ pixels, start: position * STAGGER_MS }));
})();

/** The drop, as milliseconds from its start: when the last piece lands, when the floor flashes, clears, and the word drops and pulses. */
const LANDED_AT = PIECES[PIECES.length - 1]!.start + FALL_MS;
const ROW_FLASH_AT = LANDED_AT + 150;
const CLEAR_AT = ROW_FLASH_AT + 3 * ROW_FLASH_MS;
const DROP_AT = CLEAR_AT + 90;
const SETTLED_AT = DROP_AT + DROP_MS;
const PULSE_AT = SETTLED_AT + 250;
const DURATION_MS = PULSE_AT + 3 * PULSE_MS;

type Rgb = readonly [red: number, green: number, blue: number];
/** A lit pixel: the brand orange, or the terminal's own foreground. */
type Cell = Rgb | 'foreground';

/** The brand orange (docs.json), the color of a piece in flight and of the accents. */
const ORANGE: Rgb = [0xff, 0x80, 0x01];

/** How colors are written: what the stream's color depth allows. */
type Palette = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

/** What the wordmark needs from an output stream; `process.stdout` and `process.stderr` qualify. */
export interface WordmarkStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  write(text: string): unknown;
  getColorDepth?(): number;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** `cell` moved toward white by `amount` in [0, 1]; the terminal's foreground stays what it is. */
function brighten(cell: Cell, amount: number): Cell {
  if (cell === 'foreground') return cell;
  return [
    Math.round(Math.min(255, cell[0] + (255 - cell[0]) * amount)),
    Math.round(Math.min(255, cell[1] + (255 - cell[1]) * amount)),
    Math.round(Math.min(255, cell[2] + (255 - cell[2]) * amount)),
  ];
}

/** The xterm 256-color cube levels. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestCubeLevel(channel: number): number {
  let best = 0;
  for (let level = 1; level < CUBE_LEVELS.length; level++) {
    if (Math.abs(CUBE_LEVELS[level]! - channel) < Math.abs(CUBE_LEVELS[best]! - channel)) best = level;
  }
  return best;
}

/** The SGR sequence that paints `cell` in `palette`; empty when the palette has no colors. */
function sgr(cell: Cell, palette: Palette): string {
  if (palette === 'none') return '';
  if (cell === 'foreground') return `${ESC}[39m`;
  switch (palette) {
    case 'truecolor':
      return `${ESC}[38;2;${cell[0]};${cell[1]};${cell[2]}m`;
    case 'ansi256':
      return `${ESC}[38;5;${16 + 36 * nearestCubeLevel(cell[0]) + 6 * nearestCubeLevel(cell[1]) + nearestCubeLevel(cell[2])}m`;
    case 'ansi16':
      return (cell[0] + cell[1] + cell[2]) / 3 > 215 ? `${ESC}[93m` : `${ESC}[33m`;
  }
}

/** The quadrant block for each set of lit pixels in a cell: bit 1 upper left, 2 upper right, 4 lower left, 8 lower right. */
const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const;

/** Pixels to terminal cells: two by two pixels make one quadrant block, painted in runs of one color. */
function cells(grid: readonly (readonly (Cell | undefined)[])[], palette: Palette): string[] {
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += PIXELS_PER_CELL) {
    let line = '';
    let current = '';
    for (let x = 0; x < BITMAP_WIDTH_PX; x += PIXELS_PER_CELL) {
      const quad = [grid[y]![x], grid[y]![x + 1], grid[y + 1]?.[x], grid[y + 1]?.[x + 1]];
      const cell = quad.find((pixel) => pixel !== undefined);
      if (cell === undefined) {
        line += ' ';
        continue;
      }
      const code = sgr(cell, palette);
      if (code !== current) {
        line += code;
        current = code;
      }
      line += QUADRANTS[quad.reduce<number>((bits, pixel, index) => (pixel === undefined ? bits : bits | (1 << index)), 0)]!;
    }
    lines.push(current === '' ? line.trimEnd() : `${line.trimEnd()}${RESET}`);
  }
  return lines;
}

/** Whether `elapsed` falls in an on beat of `count` pulses of `period` from `at`: on, off, on, ... */
function pulsing(elapsed: number, at: number, period: number, count: number): boolean {
  const beat = Math.floor((elapsed - at) / period);
  return beat >= 0 && beat < 2 * count - 1 && beat % 2 === 0;
}

/** How far a glow that started at `at` has faded: 1 at the start, 0 once `GLOW_MS` have passed or before it started. */
function glow(elapsed: number, at: number): number {
  const since = elapsed - at;
  return since >= 0 && since < GLOW_MS ? 1 - since / GLOW_MS : 0;
}

/**
 * The board `elapsed` milliseconds into the drop: the headroom, word, and
 * floor rows, with orange pieces in flight above the ones that landed, a
 * landed piece glowing briefly, the floor row flashing and clearing once
 * full, the word dropping into the cleared row, and the settled word pulsing
 * into the foreground, where it stays.
 */
function frame(elapsed: number, palette: Palette): string[] {
  const grid: (Cell | undefined)[][] = Array.from({ length: BOARD_PX }, () => Array.from({ length: BITMAP_WIDTH_PX }, () => undefined));
  const cleared = elapsed >= CLEAR_AT;
  const dropped = elapsed < DROP_AT ? 0 : Math.min(FLOOR_PX, Math.floor((elapsed - DROP_AT) / FRAME_MS) + 1);
  for (const piece of PIECES) {
    if (elapsed < piece.start) continue;
    const bottom = Math.max(...piece.pixels.map((pixel) => pixel.y));
    const progress = Math.min(1, (elapsed - piece.start) / FALL_MS);
    const offset = Math.round(lerp(HEADROOM_PX - 1 - bottom, 0, easeOutCubic(progress)));
    const landing = glow(elapsed, piece.start + FALL_MS);
    for (const pixel of piece.pixels) {
      if (cleared && pixel.y >= FLOOR_TOP) continue;
      const row = grid[pixel.y + offset + dropped];
      if (row === undefined) continue;
      row[pixel.x] = landing > 0 ? brighten(ORANGE, 0.55 * landing) : ORANGE;
    }
  }
  if (pulsing(elapsed, ROW_FLASH_AT, ROW_FLASH_MS, 2)) {
    for (let y = FLOOR_TOP; y < BOARD_PX; y++) grid[y] = grid[y]!.map((cell) => (cell === undefined ? undefined : 'foreground'));
  }
  const settling = glow(elapsed, SETTLED_AT);
  const foreground = elapsed >= DURATION_MS || pulsing(elapsed, PULSE_AT, PULSE_MS, 2);
  if (settling > 0 || foreground) {
    for (const row of grid) {
      for (let x = 0; x < BITMAP_WIDTH_PX; x++) {
        const cell = row[x];
        if (cell !== undefined) row[x] = foreground ? 'foreground' : brighten(cell, 0.4 * settling);
      }
    }
  }
  return cells(grid, palette);
}

/** The wordmark at rest: the word rows in the foreground, where the word came to rest after the drop, and a blank line under them. */
function rest(palette: Palette): string[] {
  return [...frame(DURATION_MS, palette).slice((HEADROOM_PX + FLOOR_PX) / PIXELS_PER_CELL), ''];
}

function paletteOf(stream: WordmarkStream): Palette {
  const depth = stream.getColorDepth?.() ?? 1;
  if (depth >= 24) return 'truecolor';
  if (depth >= 8) return 'ansi256';
  if (depth >= 4) return 'ansi16';
  return 'none';
}

/** The wordmark is for a terminal at least two columns wider than itself; a terminal of unknown width counts as 80 columns, like the reporters do. */
function fits(stream: WordmarkStream): boolean {
  return stream.isTTY === true && (stream.columns || 80) >= WORDMARK_WIDTH + 2;
}

/** Motion is for a person at a terminal: not for CI, whose terminal is a log, and not for a dumb terminal. */
function animates(env: NodeJS.ProcessEnv): boolean {
  return !envFlag(env, 'CI') && env.TERM !== 'dumb';
}

/**
 * The wordmark at rest as text to print above the help, ending in a blank
 * line; empty when `stream` is not a terminal wide enough for it.
 */
export function wordmarkBanner(stream: WordmarkStream): string {
  if (!fits(stream)) return '';
  return `${rest(paletteOf(stream)).join('\n')}\n`;
}

export interface PlayWordmarkOptions {
  /** The environment read for `CI` and `TERM`; the process's own by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** False prints the wordmark at rest at once: for a run that asked for no questions, and so no ceremony. */
  readonly motion?: boolean;
}

/**
 * Plays the drop on `stream` and resolves with the wordmark at rest on the
 * screen, a blank line under it, and the cursor restored. Where motion does
 * not belong the wordmark is printed at rest at once; a stream that is not a
 * wide enough terminal gets nothing. Ctrl-C during the drop restores the
 * cursor and exits 130, as an interrupted run does.
 */
export async function playWordmark(stream: WordmarkStream, options: PlayWordmarkOptions = {}): Promise<void> {
  if (!fits(stream)) return;
  const palette = paletteOf(stream);
  if (options.motion === false || !animates(options.env ?? process.env)) {
    stream.write(`${rest(palette).join('\n')}\n`);
    return;
  }
  let rows = 0;
  const paint = (lines: readonly string[]): void => {
    let payload = SYNC_START;
    if (rows > 0) payload += `${ESC}[${rows}A${ESC}[0J`;
    for (const line of lines) payload += `${line}\n`;
    rows = lines.length;
    stream.write(`${payload}${SYNC_END}`);
  };
  const interrupted = (): void => {
    stream.write(SHOW_CURSOR);
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  stream.write(HIDE_CURSOR);
  try {
    const started = performance.now();
    for (let elapsed = 0; elapsed < DURATION_MS; elapsed = performance.now() - started) {
      paint(frame(elapsed, palette));
      await sleep(FRAME_MS);
    }
    paint(rest(palette));
  } finally {
    process.off('SIGINT', interrupted);
    stream.write(SHOW_CURSOR);
  }
}
