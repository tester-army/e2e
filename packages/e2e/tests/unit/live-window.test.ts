/**
 * The live window's clamp and row count, by terminal column and never inside
 * a grapheme cluster, and the column budgets of every line the reporters clip
 * to a row: a step label, a reasoning excerpt, the exploration header and
 * step summary.
 */

import picocolors from 'picocolors';
import { describe, expect, it } from 'vitest';
import { fitColumns, visibleWidth } from '../../src/report/format.ts';
import { ExploreView } from '../../src/report/list-explore.ts';
import type { ShownEvent } from '../../src/report/list-model.ts';
import { eventLine, stepLabel } from '../../src/report/list-steps.ts';
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

  it('paints a combining mark in its base\u2019s column, a Hangul medial or final jamo in the lead\u2019s, and a fullwidth form in two', () => {
    expect(visibleWidth('e\u0301')).toBe(1);
    expect(visibleWidth('e\u0301'.repeat(3))).toBe(3);
    // 한 spelled as lead, medial, and final jamo: one syllable block, two columns.
    expect(visibleWidth('\u1112\u1161\u11ab')).toBe(2);
    expect(visibleWidth('\u1161\u11ab')).toBe(0);
    expect(visibleWidth('ＡＢＣ')).toBe(6);
    expect(visibleWidth('１２３')).toBe(6);
    expect(visibleWidth('￥')).toBe(2);
  });

  it('gives a format character other than the joiner and the variation selectors no column', () => {
    // Zero width space, left-to-right mark, word joiner, byte order mark.
    expect(visibleWidth('a\u200bb')).toBe(2);
    expect(visibleWidth('\u200e\u2060\ufeff')).toBe(0);
    expect(visibleWidth('ab\u200e')).toBe(2);
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
    expect(fitColumns('e\u0301'.repeat(5), 3)).toBe('e\u0301e\u0301…');
  });
});

const pc = picocolors.createColors(false);

describe('stepLabel', () => {
  it('spends its 72-column budget in columns, so a CJK label keeps half the glyphs an ASCII one does', () => {
    expect(stepLabel('a'.repeat(72))).toBe(`"${'a'.repeat(72)}"`);
    expect(stepLabel('日'.repeat(36))).toBe(`"${'日'.repeat(36)}"`);
    const clipped = stepLabel('日'.repeat(40));
    expect(clipped).toBe(`"${'日'.repeat(35)}…"`);
    expect(visibleWidth(clipped)).toBe(73);
  });

  it('clips to a row budget by column, never under 24 columns', () => {
    expect(stepLabel('日'.repeat(30), 40)).toBe(`"${'日'.repeat(19)}…"`);
    expect(stepLabel('日'.repeat(30), 10)).toBe(`"${'日'.repeat(11)}…"`);
    expect(visibleWidth(stepLabel('日'.repeat(30), 10))).toBe(25);
  });
});

describe('eventLine', () => {
  const turn = (reasoning: string): ShownEvent =>
    ({ kind: 'model', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1_200, status: 'passed', reasoning }) as unknown as ShownEvent;

  it('clips a CJK reasoning excerpt to the columns left on the row, not to that many code points', () => {
    const line = eventLine(pc, turn('日'.repeat(40)), { maxWidth: 60 });
    expect(line).toBe(`• Thinking (1.20s) · ${'日'.repeat(19)}…`);
    expect(visibleWidth(line)).toBe(60);
  });

  it('keeps an excerpt that fits the row in columns whole', () => {
    expect(eventLine(pc, turn('日'.repeat(19)), { maxWidth: 60 })).toBe(`• Thinking (1.20s) · ${'日'.repeat(19)}`);
  });
});

describe('ExploreView', () => {
  const budgets = { maxSteps: 4, timeoutMs: 300_000 };

  it('clips a CJK goal in the header to the columns after the badge and verb', () => {
    const view = new ExploreView(pc, { goal: '日'.repeat(50), budgets }, () => 0);
    const header = view.header('|web|', 'Exploring', 60);
    expect(header).toBe(` ❯ |web| Exploring  ${'日'.repeat(19)}…`);
    expect(visibleWidth(header)).toBe(59);
    expect(view.header('|web|', 'Exploring')).toBe(` ❯ |web| Exploring  ${'日'.repeat(50)}`);
  });

  it('clips a failed step\u2019s CJK summary to the terminal width in columns', () => {
    const restore = withTerminalSize({ rows: 40, columns: 60 });
    try {
      const view = new ExploreView(pc, { goal: 'checkout', budgets }, () => 0);
      const step = { index: 1, title: 'Cart', instruction: 'Open the cart', status: 'failed' as const, summary: '日'.repeat(40), startedAt: '2026-01-01T00:00:00.000Z', durationMs: 32_000 };
      const [, summary] = view.stepLines({ step, actions: 0, findings: 0 });
      expect(summary).toBe(`        ${'日'.repeat(24)}…`);
      expect(visibleWidth(summary!)).toBe(57);
    } finally {
      restore();
    }
  });
});
