import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playWordmark, wordmarkBanner, type WordmarkStream } from '../../src/cli/wordmark.ts';

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
}));

const ESC = '\u001b';

const REST = [
  '                     ▗▄▟█████▙▄',
  '                    ▟██▛▀▀▀▀▀███▖',
  '   ▄▟██████▄▖      ▟██▛       ███▖      ▗▄██████▙▄',
  ' ▄███▀▀▀▀▀▜██▙     ▝▀▀        ███▘    ▗▟██▛▀▀▀▀▀███▖',
  '▐██▛       ▐██▌            ▗▄███▀     ███▘       ███',
  '▀▀▀████████████         ▄▟███▛▀      ▝▀▀▜███████████▌',
  '▄▄▄▀▀▀▀▀▀▀▀▀▀▀▀      ▄▟███▀▘         ▗▄▄▞▀▀▀▀▀▀▀▀▀▀▀▘',
  '▐██▙       ▗▄▄▖     ▟██▛▘             ███▖       ▄▄▄',
  ' ▀███▄▄▄▄▄▟██▛     ▟███▄▄▄▄▄▄▄▄▄▄▖    ▝▜██▙▄▄▄▄▄███▘',
  '   ▀▀█████▛▀▘         ▐██████████▘      ▝▀▜█████▀▀',
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
  it('draws the wordmark at rest as plain quadrant blocks in the terminal foreground, with no styling at any color depth', () => {
    for (const depth of [24, 8, 4, 1]) {
      expect(wordmarkBanner(stream({ depth }))).toBe(`${REST.join('\n')}\n`);
    }
  });

  it('is empty when the output is not a terminal, or a terminal too narrow for it', () => {
    expect(wordmarkBanner(stream({ tty: false }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 54 }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 55 }))).not.toBe('');
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
      [stream({ rows: 10 }), { env: {} }],
    ] as const) {
      await playWordmark(out, options);
      expect(out.writes).toEqual([`${REST.join('\n')}\n\n`]);
    }
  });

  it('writes the word in over a second or so, repainting in place with a dim edge behind the pen, and leaves it at rest with the cursor shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.setTimerTickMode('nextTimerAsync');
    const out = stream();
    const started = performance.now();
    await playWordmark(out, { env: {} });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(3000);

    expect(out.writes[0]).toBe(`${ESC}[?25l`);
    expect(out.writes.at(-1)).toBe(`${ESC}[?25h`);
    const paints = out.writes.slice(1, -1);
    expect(paints.length).toBeGreaterThan(10);
    // Every paint is one synchronized update of the ten word rows; every paint after the first erases the one before.
    expect(paints.every((paint) => paint.startsWith(`${ESC}[?2026h`) && paint.endsWith(`${ESC}[?2026l`))).toBe(true);
    expect(paints.slice(1).every((paint) => paint.startsWith(`${ESC}[?2026h${ESC}[10A${ESC}[0J`))).toBe(true);
    const first = stripVTControlCharacters(paints[0]!);
    expect(first.split('\n')).toHaveLength(11);
    // The ink just behind the pen is dim; nothing is ever colored.
    expect(paints.some((paint) => paint.includes(`${ESC}[2m`))).toBe(true);
    expect(paints.every((paint) => !paint.includes('38;') && !paint.includes(`${ESC}[39m`))).toBe(true);
    // The first e is written before the last one starts: at a quarter of the way the left glyph has ink and the right one none.
    const quarter = stripVTControlCharacters(paints[Math.floor(paints.length / 4)]!).split('\n');
    expect(quarter.some((line) => /\S/u.test(line.slice(0, 15)))).toBe(true);
    expect(quarter.every((line) => line.slice(38).trim() === '')).toBe(true);
    // The last paint is the word at rest, unstyled, in place, with a blank line under it.
    expect(paints.at(-1)).toBe(`${ESC}[?2026h${ESC}[10A${ESC}[0J${REST.join('\n')}\n\n${ESC}[?2026l`);
  });
});
