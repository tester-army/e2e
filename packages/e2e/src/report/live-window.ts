/**
 * Live block for TTY reporters, after vitest's window renderer: the reporter
 * supplies the lines, the window keeps them painted below the permanent log
 * and repaints on a timer so elapsed times tick. Constructed without a raw
 * control channel it is a no-op, so callers never branch.
 */

import { terminalColumns, terminalRows } from './format.ts';

const ESC = '\u001b';
/** Matches the reporter's animation frame, so spinners advance every repaint. */
const REPAINT_INTERVAL_MS = 80;
/** Synchronized-output markers: terminals that support them repaint atomically. */
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

/**
 * Clamps one line to the terminal width, skipping ANSI sequences when
 * counting. The erase sequence counts physical rows, so a line that wraps
 * would leave stale fragments behind on every repaint.
 */
function clampToWidth(text: string, columns: number): string {
  // Two columns of margin: the ellipsis takes one, and a line that reaches
  // the exact width puts some terminals into pending-wrap, which breaks the
  // erase row count the same way real wrapping does.
  const max = Math.max(4, columns - 2);
  let width = 0;
  let out = '';
  for (let i = 0; i < text.length; ) {
    const char = text[i] as string;
    if (char === ESC) {
      const end = text.indexOf('m', i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (width >= max) return `${out}${ESC}[0m…`;
    out += char;
    width += 1;
    i += 1;
  }
  return out;
}

export class LiveWindow {
  /** Rows the block currently occupies below the log. */
  private rows = 0;
  private active = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly raw: ((text: string) => void) | undefined,
    private readonly getWindow: () => readonly string[],
  ) {}

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
    const all = this.getWindow();
    // Safety net under the reporter's own budget: a block taller than the
    // screen breaks the cursor-up erase, so the top of it is dropped.
    const maxRows = terminalRows() - 1;
    const lines = all.length > maxRows ? all.slice(all.length - maxRows) : all;
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
