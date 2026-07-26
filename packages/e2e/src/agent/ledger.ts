/** Attempt-scoped append-only step ledger (spec 10-determinism.md). */

import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';

/** Maximum size of one handoff, before ledger-wide compaction. */
export const MAX_HANDOFF_BYTES = 700;

export interface LedgerEntry {
  readonly method: string;
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'timed-out' | 'cancelled';
  /** Bounded untrusted observation carried forward to the next invocation. */
  readonly handoff: string | undefined;
}

export interface LedgerContext {
  readonly text: string;
  readonly bytes: number;
}

/**
 * Serial-group members share one ledger; independent tests never do. Entries
 * are untrusted quoted evidence and never carry policy authority.
 */
export class Ledger {
  private readonly entries: LedgerEntry[] = [];

  constructor(private readonly maxBytes: number) {}

  /** Appends one completed top-level step. */
  append(entry: {
    method: string;
    label: string;
    status: LedgerEntry['status'];
    handoff?: string;
  }): void {
    this.entries.push({
      method: entry.method,
      label: truncateUtf8(sanitizeText(entry.label), 256),
      status: entry.status,
      handoff:
        entry.handoff === undefined
          ? undefined
          : truncateUtf8(sanitizeText(entry.handoff), MAX_HANDOFF_BYTES),
    });
  }

  /** Replaces the newest entry's handoff, used after an agent step succeeds. */
  setLatestHandoff(handoff: string): void {
    const last = this.entries.pop();
    if (last === undefined) return;
    this.entries.push({
      ...last,
      handoff: truncateUtf8(sanitizeText(handoff), MAX_HANDOFF_BYTES),
    });
  }

  /**
   * Serializes newest entries first until the resolved budget is reached, then
   * emits them chronologically and prepends the dropped count.
   */
  serialize(): LedgerContext {
    const encoder = new TextEncoder();
    const lines: string[] = [];
    let bytes = 0;
    let index = this.entries.length - 1;
    for (; index >= 0; index -= 1) {
      const line = formatEntry(this.entries[index]!, index + 1);
      const size = encoder.encode(`${line}\n`).byteLength;
      if (bytes + size > this.maxBytes) break;
      bytes += size;
      lines.push(line);
    }
    lines.reverse();
    const dropped = index + 1;
    if (dropped > 0) lines.unshift(`[${dropped} earlier step(s) omitted]`);
    const text = lines.join('\n');
    return { text, bytes: encoder.encode(text).byteLength };
  }

  size(): number {
    return this.entries.length;
  }
}

function formatEntry(entry: LedgerEntry, position: number): string {
  const head = `${position}. ${entry.method} ${entry.status}${
    entry.label === '' ? '' : ` :: ${entry.label}`
  }`;
  return entry.handoff === undefined ? head : `${head}\n   observed: ${entry.handoff}`;
}
