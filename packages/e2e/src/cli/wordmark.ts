/**
 * The e2e wordmark: the logotype from the e2e design system, six rows of
 * horizontal bars, drawn in full blocks in the terminal's own foreground the
 * way the logo pack's black and white files fill it. On a terminal that
 * can show it the logo shades in, ░ to ▒ to ▓ to █, each row starting a beat
 * after the one above it.
 * Where motion does not belong it is printed at rest, and output that is not
 * a terminal never sees it.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { envFlag } from '../internal/env.ts';

const ESC = '\u001b';
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

const WORDMARK_WIDTH = BARS[0]!.length;

/**
 * The logo as text: each bar one row of full blocks, rows stacked with no
 * blank row between them, so the terminal's own line spacing is the gap
 * between bars and no bar is ever split across two rows.
 */
const LOGO: readonly string[] = BARS.map((bar) => bar.replaceAll('#', '█').replaceAll('.', ' ').trimEnd());

/** Terminal rows the wordmark takes. */
const WORDMARK_ROWS = LOGO.length;

const FRAME_MS = 16;
/** The shades a bar passes through, from blank to solid. */
const SHADES = [' ', '░', '▒', '▓', '█'] as const;
/** How long one row takes to shade in, and how much later each row starts than the one above it. */
const ROW_MS = 360;
const ROW_STAGGER_MS = 40;
const DURATION_MS = ROW_MS + ROW_STAGGER_MS * (WORDMARK_ROWS - 1);

/** What the wordmark needs from an output stream; `process.stdout` and `process.stderr` qualify. */
export interface WordmarkStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(text: string): unknown;
}

/**
 * The logo `elapsed` milliseconds into the animation: each row's bars in the
 * shade its progress has reached, easing out so the light shades pass
 * quickly and the solid one settles in.
 */
function frame(elapsed: number): readonly string[] {
  return LOGO.map((text, row) => {
    const progress = Math.min(1, Math.max(0, (elapsed - row * ROW_STAGGER_MS) / ROW_MS));
    const shade = SHADES[Math.min(SHADES.length - 1, Math.floor((1 - (1 - progress) ** 3) * SHADES.length))]!;
    return shade === ' ' ? '' : text.replaceAll('█', shade);
  });
}

/** The wordmark at rest: the logo rows, plain. */
function rest(): readonly string[] {
  return LOGO;
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
 * Scans the logo in on `stream` and resolves with it at rest on
 * the screen, one blank line under it, and the cursor restored. Where motion does not
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
      paint(frame(elapsed));
      await sleep(FRAME_MS);
    }
    paint([...rest(), '']);
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    stream.write(SHOW_CURSOR);
  }
}
