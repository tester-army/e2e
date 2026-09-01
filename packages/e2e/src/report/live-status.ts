/**
 * Live in-progress block for TTY reporters: the currently executing pairs and
 * one progress counter line, repainted below the permanent log. Constructed
 * without a raw control channel it is a no-op, so callers never branch.
 */

import pc from 'picocolors';

const ESC = '\u001b';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 120;

/**
 * Clamps one status line to the terminal width, skipping ANSI sequences when
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

export class LiveStatus {
  /**
   * Entries currently executing, keyed by the caller, in start order. An
   * undefined text counts toward the progress line without rendering a row,
   * for entries whose story streams permanently above the block.
   */
  private readonly running = new Map<string, string | undefined>();
  /** Lines the status block currently occupies below the log. */
  private statusLines = 0;
  /** Planned entries; 0 until the plan is announced. */
  private total = 0;
  /** Entries with a reported result. */
  private done = 0;
  /** Current spinner frame; advanced by the animation timer. */
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly raw: ((text: string) => void) | undefined) {}

  /** Animates while any entry renders; stopped and unref'd otherwise. */
  private syncTimer(visible: number): void {
    if (this.raw === undefined) return;
    if (visible === 0) {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.redraw();
    }, SPINNER_INTERVAL_MS);
    this.timer.unref();
  }

  /** Announces how many entries the run will execute. */
  plan(total: number): void {
    this.total = total;
    this.redraw();
  }

  /** Shows one started entry in the block; undefined counts it invisibly. */
  start(key: string, text: string | undefined): void {
    this.running.set(key, text);
    this.redraw();
  }

  /** Counts one finished entry and removes it from the block. */
  finish(key: string): void {
    this.done += 1;
    this.running.delete(key);
  }

  /** Counts one finished entry that never appeared in the block. */
  skip(): void {
    this.done += 1;
    this.redraw();
  }

  /** Clears the block so permanent log lines can be appended. */
  erase(): void {
    if (this.raw === undefined || this.statusLines === 0) return;
    this.raw(`${ESC}[${this.statusLines}A${ESC}[0J`);
    this.statusLines = 0;
  }

  /**
   * Repaints the block below the permanent log. An entry may span several
   * lines (test header, current step, recent calls); the marker goes on the
   * first line and every line is clamped so the row count stays exact.
   */
  redraw(): void {
    if (this.raw === undefined) return;
    const columns = process.stdout.columns ?? 100;
    let payload = this.statusLines > 0 ? `${ESC}[${this.statusLines}A${ESC}[0J` : '';
    let rows = 0;
    let visible = 0;
    const marker = SPINNER_FRAMES[this.frame] ?? '▸';
    for (const text of this.running.values()) {
      if (text === undefined) continue;
      visible += 1;
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const prefixed = index === 0 ? `${pc.cyan(marker)} ${line}` : line;
        payload += `${clampToWidth(prefixed, columns)}\n`;
        rows += 1;
      }
    }
    const progress = this.progressLine();
    if (progress !== undefined) payload += `${clampToWidth(progress, columns)}\n`;
    this.statusLines = rows + (progress === undefined ? 0 : 1);
    if (payload !== '') this.raw(payload);
    this.syncTimer(visible);
  }

  /** One bounded counter line: completed, executing, and waiting entries. */
  private progressLine(): string | undefined {
    if (this.total === 0) return undefined;
    const waiting = Math.max(0, this.total - this.done - this.running.size);
    const parts = [
      `${this.done}/${this.total} done`,
      `${this.running.size} running`,
      `${waiting} waiting`,
    ];
    return pc.dim(`  ${parts.join(' · ')}`);
  }
}
