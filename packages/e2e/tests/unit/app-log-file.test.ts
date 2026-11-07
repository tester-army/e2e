/**
 * The app-log file writer: every entry streamed to `app-log.txt`, one line
 * each, redacted before its whitespace folds, capped by bytes, and an empty or
 * unopenable file never claimed as an artifact.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOG_FILE, createAppLogFile } from '../../src/run/app-log-file.ts';
import type { AppLogEntry } from '../../src/engine/index.ts';

const dirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-log-file-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noRedact = (text: string): string => text;
const entry = (level: AppLogEntry['level'], source: AppLogEntry['source'], text: string): AppLogEntry => ({ level, source, text });

describe('createAppLogFile', () => {
  it('writes one line per entry as `<at> <level> <source> <text>`', () => {
    const dir = scratchDir();
    const writer = createAppLogFile({ dir, maxBytes: 10_000, redact: noRedact });
    writer.write(entry('warning', 'console', 'deprecated prop'), '2026-10-21T04:05:06.123Z');
    expect(writer.close()).toBe(true);
    expect(readFileSync(path.join(dir, APP_LOG_FILE), 'utf8')).toBe(
      '2026-10-21T04:05:06.123Z warning console deprecated prop\n',
    );
  });

  it('writes every entry, uncapped by count: 250 info lines all land in the file', () => {
    const dir = scratchDir();
    const writer = createAppLogFile({ dir, maxBytes: 10_000_000, redact: noRedact });
    for (let i = 0; i < 250; i += 1) writer.write(entry('info', 'console', `line ${i}`), '2026-01-01T00:00:00.000Z');
    expect(writer.close()).toBe(true);
    const lines = readFileSync(path.join(dir, APP_LOG_FILE), 'utf8').split('\n');
    expect(lines.length).toBe(251); // 250 entries + the trailing empty segment after the last newline
    expect(lines[0]).toBe('2026-01-01T00:00:00.000Z info console line 0');
    expect(lines[249]).toBe('2026-01-01T00:00:00.000Z info console line 249');
  });

  it('redacts before folding whitespace, so a secret that spans a newline never survives the fold', () => {
    const dir = scratchDir();
    const writer = createAppLogFile({ dir, maxBytes: 10_000, redact: (text) => text.replaceAll('old\nsecret', '[MASK]') });
    writer.write(entry('error', 'system', 'see old\nsecret   now'), '2026-01-01T00:00:00.000Z');
    writer.close();
    const file = readFileSync(path.join(dir, APP_LOG_FILE), 'utf8');
    expect(file).toBe('2026-01-01T00:00:00.000Z error system see [MASK] now\n');
    expect(file).not.toContain('secret');
  });

  it('appends one stop line once the byte cap is hit and drops later entries', () => {
    const dir = scratchDir();
    // "2026-01-01T00:00:00.000Z info console aaa\n" is 42 bytes. A 140-byte cap
    // reserves 96 for the marker, so the entry budget is 44: the first line fits
    // (42), the second trips the stop, and the marker still fits under 140.
    const writer = createAppLogFile({ dir, maxBytes: 140, redact: noRedact });
    writer.write(entry('info', 'console', 'aaa'), '2026-01-01T00:00:00.000Z');
    writer.write(entry('info', 'console', 'bbb'), '2026-01-01T00:00:00.000Z'); // over the entry budget → stop
    writer.write(entry('info', 'console', 'ccc'), '2026-01-01T00:00:00.000Z'); // after stop → dropped
    expect(writer.close()).toBe(true);
    const file = readFileSync(path.join(dir, APP_LOG_FILE), 'utf8');
    const lines = file.split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe('2026-01-01T00:00:00.000Z info console aaa');
    expect(lines.at(-1)).toBe('[e2e] app log stopped at 42 bytes of 140 (appLog.maxBytes), 1 entries');
    expect(lines).toHaveLength(2); // one entry + the stop line
  });

  it('keeps entries but omits the marker when the cap is too small to reserve one', () => {
    const dir = scratchDir();
    // A 50-byte cap is below the 96-byte marker reserve, so entries are written
    // against the full cap and the stop marker is skipped rather than overflowing.
    const writer = createAppLogFile({ dir, maxBytes: 50, redact: noRedact });
    writer.write(entry('info', 'console', 'aaa'), '2026-01-01T00:00:00.000Z'); // 42 fits
    writer.write(entry('info', 'console', 'bbb'), '2026-01-01T00:00:00.000Z'); // 84 > 50 → stop, no marker
    expect(writer.close()).toBe(true);
    const lines = readFileSync(path.join(dir, APP_LOG_FILE), 'utf8').split('\n').filter((l) => l !== '');
    expect(lines).toEqual(['2026-01-01T00:00:00.000Z info console aaa']);
  });

  it('records nothing when the cap cannot even hold one entry', () => {
    const dir = scratchDir();
    const writer = createAppLogFile({ dir, maxBytes: 10, redact: noRedact });
    writer.write(entry('info', 'console', 'aaa'), '2026-01-01T00:00:00.000Z'); // 42 > 10 → stop, no marker, no entry
    expect(writer.close()).toBe(false);
    expect(existsSync(path.join(dir, APP_LOG_FILE))).toBe(false);
  });

  it('removes the file and reports nothing to register when no entry was written', () => {
    const dir = scratchDir();
    const writer = createAppLogFile({ dir, maxBytes: 10_000, redact: noRedact });
    expect(writer.close()).toBe(false);
    expect(existsSync(path.join(dir, APP_LOG_FILE))).toBe(false);
  });

  it('is a silent no-op when the directory cannot hold the file', () => {
    const missing = path.join(scratchDir(), 'does-not-exist');
    const writer = createAppLogFile({ dir: missing, maxBytes: 10_000, redact: noRedact });
    expect(() => writer.write(entry('info', 'console', 'x'), '2026-01-01T00:00:00.000Z')).not.toThrow();
    expect(writer.close()).toBe(false);
  });

  it('ignores a write after close instead of throwing on the closed descriptor', () => {
    const dir = scratchDir();
    const writer = createAppLogFile({ dir, maxBytes: 10_000, redact: noRedact });
    writer.write(entry('info', 'console', 'one'), '2026-01-01T00:00:00.000Z');
    expect(writer.close()).toBe(true);
    expect(() => writer.write(entry('info', 'console', 'two'), '2026-01-01T00:00:00.000Z')).not.toThrow();
    // The file still holds only the entry written before close.
    expect(readFileSync(path.join(dir, APP_LOG_FILE), 'utf8')).toBe('2026-01-01T00:00:00.000Z info console one\n');
  });
});
