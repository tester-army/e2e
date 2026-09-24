import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { playWordmark, wordmarkBanner, type WordmarkStream } from '../../src/cli/wordmark.ts';

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

function stream(options: { tty?: boolean; columns?: number; depth?: number } = {}): FakeStream {
  const writes: string[] = [];
  return {
    writes,
    isTTY: options.tty ?? true,
    columns: options.columns ?? 100,
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

  afterEach(() => {
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  });

  it('writes nothing to a stream that is not a terminal', async () => {
    const out = stream({ tty: false });
    await playWordmark(out, { env: {} });
    expect(out.writes).toEqual([]);
  });

  it('prints the wordmark at rest, without motion, in CI, on a dumb terminal, and when motion is declined', async () => {
    for (const options of [{ env: { CI: 'true' } }, { env: { TERM: 'dumb' } }, { env: {}, motion: false }]) {
      const out = stream({ depth: 1 });
      await playWordmark(out, options);
      expect(out.writes).toEqual([`${REST.join('\n')}\n`]);
    }
  });

  it('drops the pieces in over two seconds or so, repainting in place, flashing the cleared row, and leaves the wordmark at rest with the cursor shown', async () => {
    const out = stream();
    const started = performance.now();
    await playWordmark(out, { env: {} });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(4000);

    expect(out.writes[0]).toBe(`${ESC}[?25l`);
    expect(out.writes.at(-1)).toBe(`${ESC}[?25h`);
    const paints = out.writes.slice(1, -1);
    expect(paints.length).toBeGreaterThan(10);
    // Every paint is one synchronized update; every paint after the first erases the eleven board rows of the one before.
    expect(paints.every((paint) => paint.startsWith(`${ESC}[?2026h`) && paint.endsWith(`${ESC}[?2026l`))).toBe(true);
    expect(paints.slice(1).every((paint) => paint.startsWith(`${ESC}[?2026h${ESC}[11A${ESC}[0J`))).toBe(true);
    const first = stripVTControlCharacters(paints[0]!);
    expect(first.split('\n')).toHaveLength(12);
    // Pieces in flight and the floor row are dim; nothing is ever colored.
    expect(paints.some((paint) => paint.includes(`${ESC}[2m`))).toBe(true);
    expect(paints.every((paint) => !paint.includes('38;') && !paint.includes(`${ESC}[39m`))).toBe(true);
    // The last paint leaves the word where it landed: the row it dropped from, blank, then the ten rows at rest, unstyled.
    expect(paints.at(-1)).toBe(`${ESC}[?2026h${ESC}[11A${ESC}[0J\n${REST.join('\n')}\n${ESC}[?2026l`);
  });
});
