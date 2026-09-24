/**
 * The e2e wordmark: `e2e` set in Stack Sans Notch, the TesterArmy display
 * face, drawn in quadrant blocks in the terminal's own foreground the way the
 * site sets it in white on dark. On a terminal that can show it the letters
 * drop in as blocks, the way the pi installer builds its mark: dim pieces fall
 * and turn solid as they land on a dim floor row, the row fills, flashes, and
 * clears, the word drops into place and pulses twice. Where motion does not
 * belong it is printed at rest, and output that is not a terminal never sees
 * it.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { envFlag } from '../internal/env.ts';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const SOLID = `${ESC}[22m`;
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
/** The floor row the pieces stack on, taken away by the clear; the word then drops into it. */
const FLOOR_PX = 2;
/** Pixel rows of the board: the word, then the floor. Pieces enter from above the board, clipped. */
const BOARD_PX = WORDMARK_PX + FLOOR_PX;
const FLOOR_TOP = WORDMARK_PX;
/** Each glyph falls as three pieces, cut along these pixel rows of the bitmap, top to bottom. */
const BANDS: readonly (readonly [top: number, bottom: number])[] = [
  [0, 5],
  [6, 13],
  [14, 19],
];

const FRAME_MS = 33;
/** One piece starts falling every `STAGGER_MS`; each takes `FALL_MS`. */
const STAGGER_MS = 60;
const FALL_MS = 240;
/** The full floor row flashes twice, clears, and the word drops one row over two frames. */
const ROW_FLASH_MS = 70;
const DROP_MS = 2 * FRAME_MS;
/** The settled word pulses twice. */
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

/** The glyph's lit pixels between two bitmap rows. */
function glyphPixels(glyph: string, top: number, bottom: number): Pixel[] {
  const pixels: Pixel[] = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < BITMAP_WIDTH_PX; x++) {
      if (BITMAP[y]![x] === glyph) pixels.push({ x, y });
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

/** A lit pixel: solid, in the terminal's foreground, or dim while it is scaffolding or in flight. */
type Cell = 'solid' | 'dim';

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

/** The quadrant block for each set of lit pixels in a cell: bit 1 upper left, 2 upper right, 4 lower left, 8 lower right. */
const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const;

/**
 * Pixels to terminal cells: two by two pixels make one quadrant block. Solid
 * cells carry no styling at all, so the word at rest is plain text in the
 * terminal's foreground; dim runs are marked when `styled`.
 */
function cells(grid: readonly (readonly (Cell | undefined)[])[], styled: boolean): string[] {
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += PIXELS_PER_CELL) {
    let line = '';
    let current: Cell = 'solid';
    for (let x = 0; x < BITMAP_WIDTH_PX; x += PIXELS_PER_CELL) {
      const quad = [grid[y]![x], grid[y]![x + 1], grid[y + 1]?.[x], grid[y + 1]?.[x + 1]];
      const cell = quad.find((pixel) => pixel !== undefined);
      if (cell === undefined) {
        line += ' ';
        continue;
      }
      if (styled && cell !== current) {
        line += cell === 'dim' ? DIM : SOLID;
        current = cell;
      }
      line += QUADRANTS[quad.reduce<number>((bits, pixel, index) => (pixel === undefined ? bits : bits | (1 << index)), 0)]!;
    }
    lines.push(line.includes(ESC) ? `${line.trimEnd()}${RESET}` : line.trimEnd());
  }
  return lines;
}

/** Whether `elapsed` falls in an on beat of `count` pulses of `period` from `at`: on, off, on, ... */
function pulsing(elapsed: number, at: number, period: number, count: number): boolean {
  const beat = Math.floor((elapsed - at) / period);
  return beat >= 0 && beat < 2 * count - 1 && beat % 2 === 0;
}

/**
 * The board `elapsed` milliseconds into the drop: the word rows and the floor
 * row, with dim pieces in flight above the solid ones that landed, the dim
 * floor row flashing solid and clearing once full, the word dropping into the
 * cleared row, and the settled word pulsing dim twice.
 */
function frame(elapsed: number, styled: boolean): string[] {
  const grid: (Cell | undefined)[][] = Array.from({ length: BOARD_PX }, () => Array.from({ length: BITMAP_WIDTH_PX }, () => undefined));
  const cleared = elapsed >= CLEAR_AT;
  const dropped = elapsed < DROP_AT ? 0 : Math.min(FLOOR_PX, Math.floor((elapsed - DROP_AT) / FRAME_MS) + 1);
  const floorSolid = pulsing(elapsed, ROW_FLASH_AT, ROW_FLASH_MS, 2);
  for (const piece of PIECES) {
    if (elapsed < piece.start) continue;
    const bottom = Math.max(...piece.pixels.map((pixel) => pixel.y));
    const progress = Math.min(1, (elapsed - piece.start) / FALL_MS);
    const offset = Math.round(lerp(-1 - bottom, 0, easeOutCubic(progress)));
    const landed = progress >= 1;
    for (const pixel of piece.pixels) {
      const floor = pixel.y >= FLOOR_TOP;
      if (cleared && floor) continue;
      const row = grid[pixel.y + offset + dropped];
      if (row === undefined) continue;
      row[pixel.x] = landed && (!floor || floorSolid) ? 'solid' : 'dim';
    }
  }
  if (pulsing(elapsed, PULSE_AT, PULSE_MS, 2)) {
    for (const row of grid) {
      for (let x = 0; x < BITMAP_WIDTH_PX; x++) if (row[x] !== undefined) row[x] = 'dim';
    }
  }
  return cells(grid, styled);
}

/** The wordmark at rest: the word rows alone, plain, where the word came to rest after the drop. */
function rest(): string[] {
  return frame(DURATION_MS, false).slice(FLOOR_PX / PIXELS_PER_CELL);
}

/** Whether the stream shows styling at all; `NO_COLOR` and a dumb terminal report a depth of one. */
function styledOn(stream: WordmarkStream): boolean {
  return (stream.getColorDepth?.() ?? 1) > 1;
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
 * The wordmark at rest as text to print above the help; empty when `stream`
 * is not a terminal wide enough for it.
 */
export function wordmarkBanner(stream: WordmarkStream): string {
  if (!fits(stream)) return '';
  return `${rest().join('\n')}\n`;
}

export interface PlayWordmarkOptions {
  /** The environment read for `CI` and `TERM`; the process's own by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** False prints the wordmark at rest at once: for a run that asked for no questions, and so no ceremony. */
  readonly motion?: boolean;
}

/**
 * Plays the drop on `stream` and resolves with the word at rest on the
 * screen, where it landed, and the cursor restored. Where motion does not
 * belong the wordmark is printed at rest at once; a stream that is not a wide
 * enough terminal gets nothing. Ctrl-C during the drop restores the cursor
 * and exits 130, as an interrupted run does.
 */
export async function playWordmark(stream: WordmarkStream, options: PlayWordmarkOptions = {}): Promise<void> {
  if (!fits(stream)) return;
  if (options.motion === false || !animates(options.env ?? process.env)) {
    stream.write(`${rest().join('\n')}\n`);
    return;
  }
  const styled = styledOn(stream);
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
      paint(frame(elapsed, styled));
      await sleep(FRAME_MS);
    }
    // The word stays where it landed: the row it dropped from stays blank above it, so nothing moves.
    paint(frame(DURATION_MS, styled));
  } finally {
    process.off('SIGINT', interrupted);
    stream.write(SHOW_CURSOR);
  }
}
