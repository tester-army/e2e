/**
 * The e2e wordmark: the logotype from the e2e design system, six rows of
 * horizontal bars, drawn in half blocks in the terminal's own foreground the
 * way the logo pack's black and white files fill it. On a terminal that can
 * show it the logo appears glitched, every row shifted sideways and dim, and
 * the rows settle into place top to bottom, each turning solid as it lands.
 * Where motion does not belong it is printed at rest, and output that is not
 * a terminal never sees it.
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
 * logo's own bar-to-gap rhythm at terminal resolution; a terminal row holds
 * two pixel rows, so every row of the output carries at most one bar.
 */
const BAR_PX = 2;
const PITCH_PX = 3;
const WORDMARK_WIDTH = BARS[0]!.length;
const WORDMARK_PX = (BARS.length - 1) * PITCH_PX + BAR_PX;
/** Terminal rows the wordmark takes. */
const WORDMARK_ROWS = Math.ceil(WORDMARK_PX / 2);

const FRAME_MS = 16;
/** Where each row starts, in columns from its place: alternating sides, so the glitch reads as a tear rather than a slide. */
const OFFSETS: readonly number[] = [-6, 5, -4, 7, -5, 4];
/** How long one row takes to settle, and how much later each row starts than the one above it. */
const ROW_MS = 300;
const ROW_STAGGER_MS = 40;
const DURATION_MS = ROW_MS + ROW_STAGGER_MS * (BARS.length - 1);

/** A lit cell: solid at rest, or dim while its row is still settling. */
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
 * The logo `elapsed` milliseconds into the animation: every row drawn, each
 * eased from its starting offset toward its place, dim until it lands.
 */
function frame(elapsed: number, styled: boolean): string[] {
  const grid: (Cell | undefined)[][] = Array.from({ length: WORDMARK_PX }, () => Array.from({ length: WORDMARK_WIDTH }, () => undefined));
  BARS.forEach((bar, index) => {
    const progress = Math.min(1, Math.max(0, (elapsed - index * ROW_STAGGER_MS) / ROW_MS));
    const shift = Math.round(OFFSETS[index]! * (1 - progress) ** 3);
    const cell: Cell = shift === 0 ? 'solid' : 'dim';
    for (let x = 0; x < WORDMARK_WIDTH; x++) {
      if (bar[x] !== '#') continue;
      const column = x + shift;
      if (column < 0 || column >= WORDMARK_WIDTH) continue;
      for (let row = 0; row < BAR_PX; row++) grid[index * PITCH_PX + row]![column] = cell;
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
 * Settles the logo in on `stream` and resolves with it at rest on the screen,
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
