/**
 * The e2e wordmark: `e2e` set in Stack Sans Notch, the TesterArmy display
 * face, drawn in quadrant blocks in the terminal's own foreground the way the
 * site sets it in white on dark. On a terminal that can show it the letters
 * are written the way a pen writes them: each `e` from the crossbar around
 * the bowl to its tail, the `2` over its arc, down the diagonal, and along the
 * base, with a dim edge of wet ink ahead of the solid stroke. Where motion
 * does not belong it is printed at rest, and output that is not a terminal
 * never sees it.
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
 * names its glyph, so each letter is written on its own. A terminal cell
 * holds two pixel rows and two pixel columns, drawn as a quadrant block.
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

/** Pixel columns per terminal column, and pixel rows per terminal row. */
const PIXELS_PER_CELL = 2;
const BITMAP_WIDTH_PX = BITMAP[0]!.length;
/** Columns the wordmark takes; a narrower terminal gets no wordmark. */
const WORDMARK_WIDTH = BITMAP_WIDTH_PX / PIXELS_PER_CELL;
const WORDMARK_PX = BITMAP.length;
/** Terminal rows the wordmark takes. */
const WORDMARK_ROWS = WORDMARK_PX / PIXELS_PER_CELL;

const FRAME_MS = 33;
/** How fast the pen travels along a letter, in bitmap pixels per second. */
const PEN_PX_PER_SECOND = 200;
/** The next letter starts when this much of the previous one is written. */
const NEXT_LETTER_AT = 0.85;
/** The share of a letter's path, just behind the pen, that is still wet: drawn dim. */
const WET_INK = 0.07;

type Point = readonly [x: number, y: number];

/** Points along an ellipse from one angle to another, degrees counterclockwise from the right, in pixel coordinates with y down. */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const steps = 60;
  return Array.from({ length: steps + 1 }, (_, step) => {
    const angle = ((from + ((to - from) * step) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(angle), cy - ry * Math.sin(angle)];
  });
}

/**
 * The pen's path for each glyph, on the bitmap above: the `e` writes its
 * crossbar left to right, then sweeps from the right side over the top, down
 * the left, and around to the tail; the `2` sweeps its arc from the left over
 * the top to the right, runs the diagonal down to the bottom left, and draws
 * the base left to right.
 */
const PATHS: Readonly<Record<string, readonly Point[]>> = {
  1: letterE(0),
  2: letter2(38),
  3: letterE(75),
};

function letterE(left: number): Point[] {
  return [[left + 5, 11], [left + 29, 11], ...arc(left + 14.5, 11.75, 14.5, 7.75, 0, 330)];
}

function letter2(left: number): Point[] {
  return [...arc(left + 14, 6, 14, 6, 195, -40), [left + 2, 17], [left, 18], [left + 28, 18]];
}

interface PathSample {
  readonly x: number;
  readonly y: number;
  /** Distance along the path from its start. */
  readonly along: number;
}

/** The path sampled about once per pixel of travel, with its total length. */
function sample(path: readonly Point[]): { readonly samples: readonly PathSample[]; readonly length: number } {
  const samples: PathSample[] = [];
  let length = 0;
  for (let index = 0; index < path.length - 1; index++) {
    const [ax, ay] = path[index]!;
    const [bx, by] = path[index + 1]!;
    const distance = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(distance));
    for (let step = 0; step < steps; step++) {
      const u = step / steps;
      samples.push({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u, along: length + distance * u });
    }
    length += distance;
  }
  const [lastX, lastY] = path[path.length - 1]!;
  samples.push({ x: lastX, y: lastY, along: length });
  return { samples, length };
}

interface InkPixel {
  readonly x: number;
  readonly y: number;
  readonly glyph: string;
  /** How far along its letter's path, in [0, 1], the pen is when it reaches this pixel. */
  readonly at: number;
}

interface Letter {
  readonly glyph: string;
  /** Milliseconds into the writing when the pen starts this letter, and how long it takes. */
  readonly start: number;
  readonly duration: number;
}

interface Layout {
  readonly PIXELS: readonly InkPixel[];
  readonly LETTERS: readonly Letter[];
  readonly DURATION_MS: number;
}
let cachedLayout: Layout | undefined;

/**
 * Every lit pixel with the moment its letter's pen reaches it: the nearest
 * point of the path, by distance along the path. Letters are written in
 * order, each starting as the previous one nears its end. Computed on first
 * use, since the CLI entry imports this module for every command.
 */
function layout(): Layout {
  if (cachedLayout !== undefined) return cachedLayout;
  const pixels: InkPixel[] = [];
  const letters: Letter[] = [];
  let start = 0;
  for (const glyph of Object.keys(PATHS)) {
    const { samples, length } = sample(PATHS[glyph]!);
    for (let y = 0; y < WORDMARK_PX; y++) {
      for (let x = 0; x < BITMAP_WIDTH_PX; x++) {
        if (BITMAP[y]![x] !== glyph) continue;
        let nearest = Number.POSITIVE_INFINITY;
        let along = 0;
        for (const point of samples) {
          const distance = (point.x - (x + 0.5)) ** 2 + (point.y - (y + 0.5)) ** 2;
          if (distance < nearest) {
            nearest = distance;
            along = point.along;
          }
        }
        pixels.push({ x, y, glyph, at: along / length });
      }
    }
    const duration = (length / PEN_PX_PER_SECOND) * 1000;
    letters.push({ glyph, start, duration });
    start += duration * NEXT_LETTER_AT;
  }
  const last = letters[letters.length - 1]!;
  cachedLayout = { PIXELS: pixels, LETTERS: letters, DURATION_MS: last.start + last.duration };
  return cachedLayout;
}

/** A lit pixel: solid ink, or dim while it is still wet just behind the pen. */
type Cell = 'solid' | 'dim';

/** What the wordmark needs from an output stream; `process.stdout` and `process.stderr` qualify. */
export interface WordmarkStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(text: string): unknown;
  getColorDepth?(): number;
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

/**
 * The word `elapsed` milliseconds into the writing: every pixel the pens
 * have reached, solid, with the stretch just behind each pen still dim.
 */
function frame(elapsed: number, styled: boolean): string[] {
  const grid: (Cell | undefined)[][] = Array.from({ length: WORDMARK_PX }, () => Array.from({ length: BITMAP_WIDTH_PX }, () => undefined));
  const { PIXELS, LETTERS } = layout();
  const progress = new Map(LETTERS.map((letter) => [letter.glyph, (elapsed - letter.start) / letter.duration]));
  for (const pixel of PIXELS) {
    const pen = progress.get(pixel.glyph)!;
    if (pixel.at > pen) continue;
    grid[pixel.y]![pixel.x] = pixel.at > pen - WET_INK ? 'dim' : 'solid';
  }
  return cells(grid, styled);
}

/** The wordmark at rest: the word rows, plain. */
function rest(): string[] {
  return frame(layout().DURATION_MS, false);
}

/** Whether the stream shows styling at all; `NO_COLOR` and a dumb terminal report a depth of one. */
function styledOn(stream: WordmarkStream): boolean {
  return (stream.getColorDepth?.() ?? 1) > 1;
}

/** The wordmark is for a terminal at least two columns wider than itself; a terminal of unknown width counts as 80 columns, like the reporters do. */
function fits(stream: WordmarkStream): boolean {
  return stream.isTTY === true && (stream.columns || 80) >= WORDMARK_WIDTH + 2;
}

/**
 * Motion is for a person at a terminal: not for CI, whose terminal is a log,
 * not for a dumb terminal, and not for a screen too short to repaint the word
 * in place, where the cursor cannot climb back over rows that scrolled away.
 * A terminal of unknown height counts as 24 rows.
 */
function animates(stream: WordmarkStream, env: NodeJS.ProcessEnv): boolean {
  return !envFlag(env, 'CI') && env.TERM !== 'dumb' && (stream.rows || 24) > WORDMARK_ROWS;
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
 * Writes the word on `stream` and resolves with it at rest on the screen, one
 * blank line under it, and the cursor restored. Where motion does not belong
 * the wordmark is printed at rest at once; a stream that is not a wide enough
 * terminal gets nothing.
 * Ctrl-C or SIGTERM during the writing restores the cursor and exits 130,
 * as an interrupted run does.
 */
export async function playWordmark(stream: WordmarkStream, options: PlayWordmarkOptions = {}): Promise<void> {
  if (!fits(stream)) return;
  if (options.motion === false || !animates(stream, options.env ?? process.env)) {
    stream.write(`${rest().join('\n')}\n\n`);
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
  process.once('SIGTERM', interrupted);
  stream.write(HIDE_CURSOR);
  try {
    const started = performance.now();
    for (let elapsed = 0; elapsed < layout().DURATION_MS; elapsed = performance.now() - started) {
      paint(frame(elapsed, styled));
      await sleep(FRAME_MS);
    }
    paint([...rest(), '']);
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    stream.write(SHOW_CURSOR);
  }
}
