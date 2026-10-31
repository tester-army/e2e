/** One attempt's uncapped app log: every entry the engine reports, streamed to `app-log.txt` beside its screenshots. */

import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { AppLogEntry } from '../engine/index.ts';

/** The artifact's file name inside the attempt's directory. */
export const APP_LOG_FILE = 'app-log.txt';

/** Bytes held back under `maxBytes` so the stop line fits inside the ceiling. */
const STOP_MARKER_RESERVE = 96;

/** Streams one attempt's app-log entries to a file and reports whether the file holds anything worth registering. */
export interface AppLogFileWriter {
  /**
   * Appends one entry as `<at> <level> <source> <text>`: the text redacted
   * before its whitespace is collapsed, so a secret never splits across the
   * fold. Never throws; a write that fails stops the capture quietly, leaving
   * the attempt to run.
   */
  write(entry: AppLogEntry, at: string): void;
  /** Closes the file and reports whether it holds any entry or a stop line; an empty file is removed and never registered. */
  close(): boolean;
}

/**
 * Creates the writer for one attempt's artifact directory, capped at `maxBytes`
 * total. Past the cap the file ends with a single line saying it stopped and
 * later entries are dropped. A directory that cannot hold the file yields a
 * silent no-op writer, so the attempt never fails over its own log.
 */
export function createAppLogFile(options: {
  readonly dir: string;
  readonly maxBytes: number;
  readonly redact: (text: string) => string;
}): AppLogFileWriter {
  const file = path.join(options.dir, APP_LOG_FILE);
  let fd: number | undefined;
  try {
    fd = openSync(file, 'a');
  } catch {
    // A directory that cannot hold the file disables the capture; the attempt
    // must never fail over writing its app log.
    return { write: () => undefined, close: () => false };
  }
  let written = 0;
  let entries = 0;
  let stopped = false;
  // The stop line is part of the file, so bytes are reserved for it below the
  // ceiling and the file never exceeds `maxBytes`. A ceiling too small to hold
  // a marker records only entries and omits the marker.
  const reserveMarker = options.maxBytes > STOP_MARKER_RESERVE;
  const entryBudget = reserveMarker ? options.maxBytes - STOP_MARKER_RESERVE : options.maxBytes;
  return {
    write(entry, at) {
      if (fd === undefined || stopped) return;
      // Redacted before the fold: a secret whose value holds whitespace would
      // survive a collapse matched only after redaction.
      const line = `${at} ${entry.level} ${entry.source} ${options.redact(entry.text).replace(/\s+/g, ' ').trim()}\n`;
      const bytes = Buffer.byteLength(line);
      if (written + bytes > entryBudget) {
        stopped = true;
        if (reserveMarker) {
          const stop = `[e2e] app log stopped at ${written} bytes of ${options.maxBytes} (appLog.maxBytes), ${entries} entries\n`;
          try {
            writeSync(fd, stop);
          } catch {
            // A stop line that cannot be written is not worth failing the attempt; the capture ends.
          }
        }
        return;
      }
      try {
        writeSync(fd, line);
      } catch {
        // A failed write must not fail an action: drop the capture from here on.
        stopped = true;
        return;
      }
      written += bytes;
      entries += 1;
    },
    close() {
      if (fd === undefined) return false;
      let closed = true;
      try {
        closeSync(fd);
      } catch {
        closed = false;
      }
      fd = undefined;
      // Register only a file that holds bytes and closed cleanly. A partial,
      // empty, or uncloseable artifact is dropped quietly: it is never worth a
      // `complete` claim, and it must never throw the attempt's close.
      if (!closed || written === 0) {
        try {
          rmSync(file, { force: true });
        } catch {
          // Left for the attempt directory's own cleanup.
        }
        return false;
      }
      return true;
    },
  };
}
