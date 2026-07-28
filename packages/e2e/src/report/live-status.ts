/**
 * Live in-progress block for TTY reporters: the currently executing pairs and
 * one progress counter line, repainted below the permanent log. Constructed
 * without a raw control channel it is a no-op, so callers never branch.
 */

import pc from 'picocolors';

export class LiveStatus {
  /** Entries currently executing, keyed by the caller, in start order. */
  private readonly running = new Map<string, string>();
  /** Lines the status block currently occupies below the log. */
  private statusLines = 0;
  /** Planned entries; 0 until the plan is announced. */
  private total = 0;
  /** Entries with a reported result. */
  private done = 0;

  constructor(private readonly raw: ((text: string) => void) | undefined) {}

  /** Announces how many entries the run will execute. */
  plan(total: number): void {
    this.total = total;
    this.redraw();
  }

  /** Shows one started entry in the block. */
  start(key: string, text: string): void {
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
    this.raw(`\u001b[${this.statusLines}A\u001b[0J`);
    this.statusLines = 0;
  }

  /** Repaints the block below the permanent log. */
  redraw(): void {
    if (this.raw === undefined) return;
    let payload = this.statusLines > 0 ? `\u001b[${this.statusLines}A\u001b[0J` : '';
    for (const text of this.running.values()) {
      payload += `${pc.dim('\u25B8')} ${text}\n`;
    }
    const progress = this.progressLine();
    if (progress !== undefined) payload += `${progress}\n`;
    this.statusLines = this.running.size + (progress === undefined ? 0 : 1);
    if (payload !== '') this.raw(payload);
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
    return pc.dim(`  ${parts.join(' \u00b7 ')}`);
  }
}
