/**
 * Live block for TTY reporters, after vitest's window renderer: the reporter
 * supplies the lines, the window keeps them painted below the permanent log
 * and repaints on a timer so elapsed times tick. Constructed without a raw
 * control channel it is a no-op, so callers never branch.
 */

import { graphemes, terminalColumns, terminalRows, visibleWidth } from './format.ts';

const ESC = '\u001b';
/**
 * Repaint cadence, and so the animation frame of anything the window shows:
 * a spinner keyed to it advances exactly once per paint.
 */
export const REPAINT_INTERVAL_MS = 80;
/**
 * Columns a window line leaves free: the ellipsis takes one, and a line that
 * reaches the exact width puts some terminals into pending-wrap, which breaks
 * the erase row count the same way real wrapping does.
 */
export const WIDTH_MARGIN = 2;
/** Synchronized-output markers: terminals that support them repaint atomically. */
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

/**
 * Clamps one line to the terminal width in columns, skipping ANSI sequences
 * when counting and never cutting inside a grapheme cluster: a glyph or emoji
 * sequence that would cross the limit is dropped whole. The erase sequence
 * counts physical rows, so a line that wraps would leave stale fragments
 * behind on every repaint.
 */
function clampToWidth(text: string, columns: number): string {
  const max = Math.max(4, columns - WIDTH_MARGIN);
  let width = 0;
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === ESC) {
      const end = text.indexOf('m', i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const next = text.indexOf(ESC, i);
    const run = text.slice(i, next === -1 ? text.length : next);
    for (const cluster of graphemes(run)) {
      if (width + cluster.columns > max) return `${out}${ESC}[0m…`;
      out += cluster.text;
      width += cluster.columns;
    }
    i += run.length;
  }
  return out;
}

/**
 * Screen rows one permanent line takes: one per wrapped row of each of its
 * lines. A line as wide as the terminal still fits in one row.
 */
function rowsOf(text: string, columns: number): number {
  let rows = 0;
  for (const line of text.split('\n')) rows += Math.max(1, Math.ceil(visibleWidth(line) / Math.max(1, columns)));
  return rows;
}

export class LiveWindow {
  /** Rows the block currently occupies below the log. */
  private rows = 0;
  /**
   * Screen rows the permanent log holds above the block: every line printed
   * since the run began, counted by wrapped rows. The block pads itself to
   * the rows under them, so the summary sits at the bottom of the screen on
   * any terminal instead of hanging mid-screen on a tall one. Rows nobody
   * counted (a worker's stray output, `--debug` on stderr) make the paint
   * scroll once, after which the count is exact again: `redraw` clamps it to
   * what the block left.
   */
  private above = 0;
  private active = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly raw: ((text: string) => void) | undefined,
    private readonly getWindow: (room: number) => readonly string[],
  ) {}

  /** Records one permanent line written above the block, so the block knows the room left under the log. */
  logged(line: string): void {
    this.above += rowsOf(line, terminalColumns());
  }

  /** Rows the block may take without scrolling the log: the screen under the log, minus the row the cursor rests on. */
  private room(): number {
    return Math.max(0, terminalRows() - 1 - this.above);
  }

  /** Begins painting; the block repaints on a timer until `stop`. */
  start(): void {
    if (this.raw === undefined || this.active) return;
    this.active = true;
    this.timer = setInterval(() => this.redraw(), REPAINT_INTERVAL_MS);
    this.timer.unref();
    this.redraw();
  }

  /** Clears the block so permanent log lines can be appended. */
  erase(): void {
    if (this.raw === undefined || this.rows === 0) return;
    this.raw(`${ESC}[${this.rows}A${ESC}[0J`);
    this.rows = 0;
  }

  /** Repaints the block below the log; every line is clamped so the row count stays exact. */
  redraw(): void {
    if (this.raw === undefined || !this.active) return;
    const columns = terminalColumns();
    const all = this.getWindow(this.room());
    // Safety net under the reporter's own budget: a block taller than the
    // screen breaks the cursor-up erase, so the top of it is dropped.
    const maxRows = terminalRows() - 1;
    const lines = all.length > maxRows ? all.slice(all.length - maxRows) : all;
    // A block taller than the room scrolls the log up by the excess; the
    // rows above it are then exactly what the block left.
    this.above = Math.min(this.above, maxRows - lines.length);
    let payload = SYNC_START;
    if (this.rows > 0) payload += `${ESC}[${this.rows}A${ESC}[0J`;
    for (const line of lines) payload += `${clampToWidth(line, columns)}\n`;
    payload += SYNC_END;
    this.rows = lines.length;
    this.raw(payload);
  }

  /**
   * Ends the block for good: the timer is cleared and the block erased, so
   * nothing repaints after the final summary in a long-lived programmatic
   * caller.
   */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
    this.erase();
  }
}
