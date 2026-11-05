import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playWordmark, wordmarkBanner, type WordmarkStream } from '../../src/cli/wordmark.ts';

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
}));

const ESC = '\u001b';

const REST = [
  '                   ███████████',
  '   ▄▄▄▄▄▄▄▄▄▄     ▄▄▄▄     ▄▄▄▄▄     ▄▄▄▄▄▄▄▄▄▄',
  '   ▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀     ▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀',
  ' ████      ████           ████     ████      ████',
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄      ▄▄▄▄      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀      ▀▀▀▀      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  ' ████              █████          ████',
  '   ▄▄▄▄▄▄▄▄▄▄     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄     ▄▄▄▄▄▄▄▄▄▄',
  '   ▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀',
];

interface FakeStream extends WordmarkStream {
  readonly writes: string[];
}

function stream(options: { tty?: boolean; columns?: number; rows?: number; depth?: number } = {}): FakeStream {
  const writes: string[] = [];
  return {
    writes,
    isTTY: options.tty ?? true,
    columns: options.columns ?? 100,
    rows: options.rows ?? 40,
    write(text: string) {
      writes.push(text);
      return true;
    },
    getColorDepth: () => options.depth ?? 24,
  };
}

describe('wordmarkBanner', () => {
  it('draws the logo at rest as plain half blocks in the terminal foreground, with no styling at any color depth', () => {
    for (const depth of [24, 8, 4, 1]) {
      expect(wordmarkBanner(stream({ depth }))).toBe(`${REST.join('\n')}\n`);
    }
  });

  it('is empty when the output is not a terminal, or a terminal too narrow for it', () => {
    expect(wordmarkBanner(stream({ tty: false }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 51 }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 52 }))).not.toBe('');
    // A pty without a size reports 0 columns, which counts as 80.
    expect(wordmarkBanner(stream({ columns: 0 }))).not.toBe('');
  });
});

describe('playWordmark', () => {
  const sigintListeners = process.listenerCount('SIGINT');
  const sigtermListeners = process.listenerCount('SIGTERM');

  afterEach(() => {
    vi.useRealTimers();
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('writes nothing to a stream that is not a terminal', async () => {
    const out = stream({ tty: false });
    await playWordmark(out, { env: {} });
    expect(out.writes).toEqual([]);
  });

  it('prints the wordmark at rest, without motion, in CI, on a dumb terminal, when motion is declined, and on a terminal too short to repaint it in place, with a blank line under it', async () => {
    for (const [out, options] of [
      [stream({ depth: 1 }), { env: { CI: 'true' } }],
      [stream({ depth: 1 }), { env: { TERM: 'dumb' } }],
      [stream({ depth: 1 }), { env: {}, motion: false }],
      [stream({ rows: 9 }), { env: {} }],
    ] as const) {
      await playWordmark(out, options);
      expect(out.writes).toEqual([`${REST.join('\n')}\n\n`]);
    }
  });

  it('scans the logo in top to bottom as thin lines, dim under the scan line, then fills every bar at once, all in half a second, and leaves it at rest with the cursor shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.setTimerTickMode('nextTimerAsync');
    const out = stream();
    const started = performance.now();
    await playWordmark(out, { env: {} });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(1000);

    expect(out.writes[0]).toBe(`${ESC}[?25l`);
    expect(out.writes.at(-1)).toBe(`${ESC}[?25h`);
    const paints = out.writes.slice(1, -1);
    expect(paints.length).toBeGreaterThan(10);
    // Every paint is one synchronized update of the nine logo rows; every paint after the first erases the one before.
    expect(paints.every((paint) => paint.startsWith(`${ESC}[?2026h`) && paint.endsWith(`${ESC}[?2026l`))).toBe(true);
    expect(paints.slice(1).every((paint) => paint.startsWith(`${ESC}[?2026h${ESC}[9A${ESC}[0J`))).toBe(true);
    const first = stripVTControlCharacters(paints[0]!);
    expect(first.split('\n')).toHaveLength(10);
    // The bar under the scan line is dim; nothing is ever colored.
    expect(paints.some((paint) => paint.includes(`${ESC}[2m`))).toBe(true);
    expect(paints.every((paint) => !paint.includes('38;') && !paint.includes(`${ESC}[39m`))).toBe(true);
    // Bars load top to bottom, never out of place: below an undrawn bar no bar is drawn, and ink only ever sits where the logo at rest has it.
    // During the scan each bar's thin line lands on one of these rows, in order.
    const thinRows = [0, 1, 3, 4, 6, 7];
    for (const paint of paints.slice(0, -1)) {
      const lines = stripVTControlCharacters(paint).split('\n').slice(0, REST.length);
      const drawn = thinRows.map((row) => lines[row]!.trim() !== '');
      const firstUndrawn = drawn.indexOf(false);
      if (firstUndrawn !== -1) expect(drawn.slice(firstUndrawn).every((bar) => !bar)).toBe(true);
      expect(lines.every((line, row) => [...line].every((char, column) => char === ' ' || REST[row]![column] !== ' '))).toBe(true);
    }
    // Until the fill every bar is a thin line, one pixel row: no paint before the last has a full block.
    expect(paints.slice(0, -1).every((paint) => !paint.includes('█'))).toBe(true);
    // A third of the way in the top bar's thin line is drawn and the bottom rows are not.
    const third = stripVTControlCharacters(paints[Math.floor(paints.length / 3)]!).split('\n');
    expect(third[0]).toBe(REST[0]!.replaceAll('█', '▀'));
    expect(third.slice(6).every((line) => line.trim() === '')).toBe(true);
    // The last paint is the logo at rest, unstyled, in place, with a blank line under it.
    expect(paints.at(-1)).toBe(`${ESC}[?2026h${ESC}[9A${ESC}[0J${REST.join('\n')}\n\n${ESC}[?2026l`);
  });
});
