/**
 * The e2e wordmark: the logotype from the e2e design system, six rows of
 * horizontal bars, drawn in half blocks in the terminal's own foreground the
 * way the logo pack's black and white files fill it. On a terminal that can
 * show it the logo loads top to bottom like a scan, half a terminal row at a
 * time, each bar dim until the scan line has passed it. Where motion does not
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
 * The logotype's six bar rows (`logo/svg/e2e-logotype-*.svg` in the design
 * system), one character per terminal column: each bar's 407-unit width
 * scaled to 50 columns, a column lit when at least half of it is covered.
 */
const BARS: readonly string[] = [
  '...................###########....................',
  '...##########.....####.....#####.....##########...',
  '.####......####...........####.....####......####.',
  '#################......####......#################',
  '.####..............#####..........####............',
  '...##########.....##############.....##########...',
];

/**
 * A bar is two half-block pixel rows tall and the gap between bars one, the
 * closest terminal resolution gets to the logo's thick bars and thin gaps; a terminal row holds
 * two pixel rows, so every row of the output carries at most one bar.
 */
const BAR_PX = 2;
const PITCH_PX = 3;
const WORDMARK_WIDTH = BARS[0]!.length;
const WORDMARK_PX = (BARS.length - 1) * PITCH_PX + BAR_PX;
/** Terminal rows the wordmark takes. */
const WORDMARK_ROWS = Math.ceil(WORDMARK_PX / 2);

const FRAME_MS = 16;
/** One pass of the scan line from the top of the logo to the bottom. */
const DURATION_MS = 500;
/** How far, in pixel rows, the scan line moves past a bar before the bar turns solid. */
const SCAN_HEAD_PX = 1.5;

/** A lit cell: solid at rest, or dim while the scan line is on its bar. */
type Cell = 'solid' | 'dim';

/** What the wordmark needs from an output stream; `process.stdout` and `process.stderr` qualify. */
export interface WordmarkStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(text: string): unknown;
  getColorDepth?(): number;
}

/** The half block for a cell's lit pixels: bit 1 the upper half, 2 the lower. */
const HALVES = [' ', '▀', '▄', '█'] as const;

/**
 * Pixels to terminal cells: two pixel rows make one half block. Solid cells
 * carry no styling at all, so the logo at rest is plain text in the
 * terminal's foreground; dim runs are marked when `styled`.
 */
function cells(grid: readonly (readonly (Cell | undefined)[])[], styled: boolean): string[] {
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    let current: Cell = 'solid';
    for (let x = 0; x < WORDMARK_WIDTH; x++) {
      const upper = grid[y]![x];
      const lower = grid[y + 1]?.[x];
      const cell = upper ?? lower;
      if (cell === undefined) {
        line += ' ';
        continue;
      }
      if (styled && cell !== current) {
        line += cell === 'dim' ? DIM : SOLID;
        current = cell;
      }
      line += HALVES[(upper === undefined ? 0 : 1) | (lower === undefined ? 0 : 2)];
    }
    lines.push(line.includes(ESC) ? `${line.trimEnd()}${RESET}` : line.trimEnd());
  }
  return lines;
}

/**
 * The logo `elapsed` milliseconds into the scan: every pixel row above the
 * scan line drawn, the bar the line is on dim, the rows below it not yet.
 */
function frame(elapsed: number, styled: boolean): string[] {
  const grid: (Cell | undefined)[][] = Array.from({ length: WORDMARK_PX }, () => Array.from({ length: WORDMARK_WIDTH }, () => undefined));
  const line = (Math.min(elapsed, DURATION_MS) / DURATION_MS) * (WORDMARK_PX + SCAN_HEAD_PX);
  BARS.forEach((bar, index) => {
    const top = index * PITCH_PX;
    const cell: Cell = line - (top + BAR_PX) < SCAN_HEAD_PX ? 'dim' : 'solid';
    for (let row = 0; row < BAR_PX && top + row < line; row++) {
      for (let x = 0; x < WORDMARK_WIDTH; x++) if (bar[x] === '#') grid[top + row]![x] = cell;
    }
  });
  return cells(grid, styled);
}

/** The wordmark at rest: the logo rows, plain. */
function rest(): string[] {
  return frame(Number.POSITIVE_INFINITY, false);
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
 * not for a dumb terminal, and not for a screen too short to repaint the logo
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
 * Scans the logo in on `stream` and resolves with it at rest on the screen,
 * one blank line under it, and the cursor restored. Where motion does not
 * belong the wordmark is printed at rest at once; a stream that is not a wide
 * enough terminal gets nothing.
 * Ctrl-C or SIGTERM during the animation restores the cursor and exits 130, as
 * an interrupted run does.
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
    for (let elapsed = 0; elapsed < DURATION_MS; elapsed = performance.now() - started) {
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
