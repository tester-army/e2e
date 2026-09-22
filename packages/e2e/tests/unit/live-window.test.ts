/** The live window's clamp and row count: by terminal column, never inside a grapheme cluster. */

import { describe, expect, it } from 'vitest';
import { fitColumns, visibleWidth } from '../../src/report/format.ts';
import { LiveWindow } from '../../src/report/live-window.ts';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const HEART = '❤️';
const KEYCAP_ONE = '1️⃣';
const FLAG = '\u{1F1F5}\u{1F1F1}';

function withTerminalSize(size: { rows: number; columns: number }): () => void {
  const saved = { rows: process.stdout.rows, columns: process.stdout.columns };
  const set = (key: 'rows' | 'columns', value: number | undefined) =>
    Object.defineProperty(process.stdout, key, { value, configurable: true, writable: true });
  set('rows', size.rows);
  set('columns', size.columns);
  return () => {
    set('rows', saved.rows);
    set('columns', saved.columns);
  };
}

/** Paints `lines` once on a terminal `columns` wide and returns that paint's payload. */
function paint(lines: readonly string[], columns: number): string {
  const restore = withTerminalSize({ rows: 40, columns });
  try {
    const payloads: string[] = [];
    const window = new LiveWindow((text) => payloads.push(text), () => lines);
    window.start();
    window.stop();
    return payloads[0]!;
  } finally {
    restore();
  }
}

/** The painted text without its control sequences and the line break. */
function shown(payload: string): string {
  return payload.replace(ANSI_PATTERN, '').replace(/\n$/u, '');
}

describe('LiveWindow', () => {
  it('never cuts a line inside a code point', () => {
    const payload = paint(['abc\u{1F600}def'], 6);
    // A lone surrogate is the one thing encodeURIComponent refuses.
    expect(() => encodeURIComponent(payload)).not.toThrow();
    expect(shown(payload)).toBe('abc…');
  });

  it('never splits a grapheme cluster: an emoji sequence goes whole or not at all', () => {
    expect(shown(paint([`ab${FAMILY}cd`], 6))).toBe(`ab${FAMILY}…`);
    expect(shown(paint([`abc${FAMILY}d`], 6))).toBe('abc…');
    expect(shown(paint([`abc${FLAG}d`], 6))).toBe('abc…');
  });

  it('clamps an emoji title at the column it reaches, two per emoji', () => {
    const payload = paint(['a\u{1F600}b\u{1F600}c'], 8);
    expect(shown(payload)).toBe('a\u{1F600}b\u{1F600}…');
    expect(visibleWidth(shown(payload))).toBe(7);
  });

  it('clamps a CJK title through a color run, keeping the sequences', () => {
    const payload = paint(['\u001b[31m日本語\u001b[0mテスト'], 12);
    expect(shown(payload)).toBe('日本語テス…');
    expect(payload).toContain('\u001b[31m日本語\u001b[0m');
  });

  it('counts a logged CJK line by the rows its columns wrap to', () => {
    const restore = withTerminalSize({ rows: 40, columns: 10 });
    try {
      const rooms: number[] = [];
      const window = new LiveWindow(
        () => undefined,
        (room) => {
          rooms.push(room);
          return [];
        },
      );
      window.start();
      window.logged('日本語テスト');
      window.redraw();
      window.stop();
      expect(rooms).toEqual([39, 37]);
    } finally {
      restore();
    }
  });
});

describe('visibleWidth', () => {
  it('counts terminal columns per grapheme cluster, not code units or code points', () => {
    expect(visibleWidth('abc')).toBe(3);
    expect(visibleWidth('日本')).toBe(4);
    expect(visibleWidth('\u{1F600}')).toBe(2);
    expect(visibleWidth(HEART)).toBe(2);
    expect(visibleWidth(FAMILY)).toBe(2);
    expect(visibleWidth(KEYCAP_ONE)).toBe(2);
    expect(visibleWidth(FLAG)).toBe(2);
    expect(visibleWidth('é')).toBe(1);
    expect(visibleWidth('\u{1F44D}\u{1F3FD}')).toBe(2);
    expect(visibleWidth('☁︎')).toBe(1);
    expect(visibleWidth('\u001b[31mab\u001b[0m')).toBe(2);
    expect(visibleWidth('❯ ✓ × └ ↳ … ✳')).toBe(13);
  });
});

describe('fitColumns', () => {
  it('leaves text that fits alone and clips by column with the ellipsis inside the budget', () => {
    expect(fitColumns('abc', 3)).toBe('abc');
    expect(fitColumns('abcd', 3)).toBe('ab…');
    expect(fitColumns('日本語テスト', 8)).toBe('日本語…');
    expect(fitColumns(`ab${HEART}cd`, 5)).toBe(`ab${HEART}…`);
    expect(fitColumns(`a${FAMILY}bc`, 4)).toBe(`a${FAMILY}…`);
    expect(visibleWidth(fitColumns('日'.repeat(60), 60))).toBe(59);
  });
});
