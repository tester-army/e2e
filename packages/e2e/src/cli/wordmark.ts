/**
 * The e2e wordmark: the logotype from the e2e design system, six rows of
 * horizontal bars, drawn in full blocks in the terminal's own foreground the
 * way the logo pack's black and white files fill it. On a terminal that
 * can show it a scan line sweeps down the logo, and each row shows its top
 * half as the line crosses it, then fills in.
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
/** One sweep of the scan line from above the top row to below the bottom one. */
const DURATION_MS = 600;
/** The scan line: a thin line across the logo's whole width. */
const SCAN_LINE = '▔';

/** What the wordmark needs from an output stream; `process.stdout` and `process.stderr` qualify. */
export interface WordmarkStream {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(text: string): unknown;
}

/**
 * The logo `elapsed` milliseconds into the scan. The scan line moves half a
 * row at a time: a row it has passed is drawn, the row it is crossing shows
 * its bars' top halves with the line in the gaps, the row it is entering is
 * the line alone, and the rows below it are blank.
 */
function frame(elapsed: number): readonly string[] {
  const line = Math.floor((elapsed / DURATION_MS) * (WORDMARK_ROWS * 2 + 1));
  return LOGO.map((text, row) => {
    const passed = line - row * 2;
    if (passed >= 2) return text;
    if (passed === 1) return text.padEnd(WORDMARK_WIDTH).replaceAll(' ', SCAN_LINE).replaceAll('█', '▀');
    if (passed === 0) return SCAN_LINE.repeat(WORDMARK_WIDTH);
    return '';
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
